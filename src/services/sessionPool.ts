import { v4 as uuidv4 } from 'uuid';
import { getBasicHeaders } from './playwright.ts';
import { pickAccount, incrementInFlight, decrementInFlight, incrementTotalRequests, getAccountByEmail, throttleAccount, getAllAccountEmails } from './auth.ts';
import { createNetworkEntry, recordResponse, completeEntry, errorEntry } from './networkDebug.ts';
import { logStore } from './logStore.js';
import { config } from './configService.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
  /** Which account email this session is bound to */
  accountEmail?: string;
}

export class SessionPoolQueueFullError extends Error {
  constructor(current: number, max: number) {
    super(`Session pool queue full (${current}/${max}). Try again later.`);
    this.name = 'SessionPoolQueueFullError';
  }
}

export class SessionPoolWaitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Session pool wait timed out after ${timeoutMs}ms`);
    this.name = 'SessionPoolWaitTimeoutError';
  }
}

interface WaiterEntry {
  resolve: (entry: PoolEntry) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function formatQwenEnvelopeError(json: any): string {
  const code = json?.data?.code || json?.code || 'unknown';
  const details = json?.data?.details || json?.details || json?.message || '';
  return details ? `${code}: ${details}` : String(code);
}

export class SessionPool {
  private waiting: Array<WaiterEntry> = [];
  private activeSessions = new Set<string>();
  private activeCount = 0;
  private readonly MAX_WAITING = 10;
  private readonly WAIT_TIMEOUT_MS = 60_000;

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      return;
    }
  }

  /**
   * Acquire a fresh session. If email is provided, use that specific account.
   * Otherwise, pick the best available account (round-robin, non-throttled).
   */
  async acquire(email?: string): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return { chatId: mockId, parentId: null, inUse: true, accountEmail: 'mock@test' };
    }

    const maxAttempts = email ? 1 : Math.max(1, getAllAccountEmails().length);
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // If no email specified, pick the best account after any previous throttling.
      const resolvedEmail = email || pickAccount()?.email;

      // Mark account as in-flight before starting async ops (runs synchronously, no race)
      if (resolvedEmail) {
        incrementInFlight(resolvedEmail);
      }

      try {
        const [{ cookie, userAgent, email: actualEmail }, chatId] = await Promise.all([
          getBasicHeaders(resolvedEmail),
          this.createSession(resolvedEmail)
        ]);
        const entry: PoolEntry = {
          chatId,
          parentId: null,
          inUse: true,
          cachedHeaders: { cookie, userAgent },
          accountEmail: actualEmail || resolvedEmail,
        };
        this.activeSessions.add(chatId);
        this.activeCount++;
        logStore.log('info', 'pool', 'Session acquired' + (entry.accountEmail ? ': ' + entry.accountEmail.split('@')[0] : ''));
        return entry;
      } catch (err: any) {
        lastErr = err;
        if (resolvedEmail) {
          decrementInFlight(resolvedEmail);
          if (!email && /pending activation|Bad_Request|Chats\/new returned no id/i.test(err?.message || '')) {
            throttleAccount(resolvedEmail, 30 * 60 * 1000);
            logStore.log('warn', 'pool', `Skipping account ${resolvedEmail}: ${err.message}`);
            continue;
          }
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('Failed to acquire session');
  }

  getWaitingCount(): number {
    return this.waiting.length;
  }

  isQueueFull(): boolean {
    return this.waiting.length >= this.MAX_WAITING;
  }

  /**
   * Enqueue a waiter with timeout. Throws SessionPoolQueueFullError if queue is at capacity,
   * or SessionPoolWaitTimeoutError if wait exceeds WAIT_TIMEOUT_MS.
   */
  enqueueWaiter(): Promise<PoolEntry> {
    if (this.isQueueFull()) {
      throw new SessionPoolQueueFullError(this.waiting.length, this.MAX_WAITING);
    }
    return new Promise<PoolEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiting.findIndex(w => w.timer === timer);
        if (idx >= 0) this.waiting.splice(idx, 1);
        reject(new SessionPoolWaitTimeoutError(this.WAIT_TIMEOUT_MS));
      }, this.WAIT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiting.push({ resolve, reject, timer });
    });
  }

  release(chatId: string, _newParentId: string | null, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): void {
    // Idempotency guard: if chatId not tracked as active, this session was already released.
    // Prevents double-release from competing cleanup paths (setTimeout + finally).
    if (!this.activeSessions.has(chatId)) {
      return;
    }

    // Track completed request — decrement in-flight, bump total count
    if (accountEmail) {
      decrementInFlight(accountEmail);
      incrementTotalRequests(accountEmail);
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      const waiterEmail = accountEmail || pickAccount()?.email;
      Promise.all([getBasicHeaders(waiterEmail), this.createSession(waiterEmail)])
        .then(([{ cookie, userAgent, email: actualEmail }, id]) => {
          waiter.resolve({ chatId: id, parentId: _newParentId, inUse: true, cachedHeaders: { cookie, userAgent }, accountEmail: actualEmail || waiterEmail });
        })
        .catch(err => {
          console.error('[SessionPool] Failed to create session for waiter:', err.message);
          waiter.reject(err);
        });
    }
    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    this.deleteSession(chatId, cachedHeaders, accountEmail);
    logStore.log('info', 'pool', 'Session released' + (accountEmail ? ': ' + accountEmail.split('@')[0] : ''));
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (config.get('DELETE_SESSION', 'true') === 'false') {
      return;
    }

    const { cookie, userAgent } = cachedHeaders || await getBasicHeaders(accountEmail);
    const requestId = uuidv4();
    const debugEntry = createNetworkEntry({
      url: `https://chat.qwen.ai/api/v2/chats/${chatId}`,
      method: 'DELETE',
      headers: { cookie, 'user-agent': userAgent, 'x-request-id': requestId },
      category: 'session-delete',
      accountEmail: accountEmail,
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        signal: controller.signal,
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'cookie': cookie,
          'referer': 'https://chat.qwen.ai/',
          'user-agent': userAgent,
          'x-request-id': requestId,
          'source': 'web',
        },
      });
      clearTimeout(timeout);
      recordResponse(debugEntry.id, response);
      if (response.ok) {
        completeEntry(debugEntry.id);
      } else {
        errorEntry(debugEntry.id, `Delete returned ${response.status}`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        errorEntry(debugEntry.id, 'Delete request aborted (timeout)');
        console.warn(`[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        errorEntry(debugEntry.id, err.message);
        console.warn(`[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
      }
    }
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number } {
    return {
      total: this.activeSessions.size,
      available: this.activeSessions.size - this.activeCount,
      inUse: this.activeCount,
      waiting: this.waiting.length,
    };
  }

  private async createSession(email?: string): Promise<string> {
    const headers = await getBasicHeaders(email);
    const { cookie, userAgent, bxUmidtoken, bxUa, bxV } = headers;
    const requestId = uuidv4();

    const acct = email ? getAccountByEmail(email) : null;
    const bearerToken = acct?.state?.token;

    const fetchHeaders: Record<string, string> = {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': requestId,
      'source': 'web',
      'bx-umidtoken': bxUmidtoken,
      'bx-ua': bxUa,
      'bx-v': bxV,
    };
    if (bearerToken) {
      fetchHeaders['authorization'] = `Bearer ${bearerToken}`;
    }

    const debugEntry = createNetworkEntry({
      url: 'https://chat.qwen.ai/api/v2/chats/new',
      method: 'POST',
      headers: fetchHeaders,
      body: {},
      category: 'session-create',
      accountEmail: email,
    });

    let response: Response;
    try {
      response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: fetchHeaders,
        body: JSON.stringify({}),
      });
      recordResponse(debugEntry.id, response);
    } catch (err) {
      errorEntry(debugEntry.id, err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (!response.ok) {
      errorEntry(debugEntry.id, `Chats/new returned ${response.status}`);
      throw new Error(`Chats/new returned ${response.status}`);
    }
    const json = await response.json();
    if (!json.data?.id) {
      const message = formatQwenEnvelopeError(json);
      errorEntry(debugEntry.id, `Chats/new returned no id: ${message}`);
      throw new Error(`Chats/new returned no id: ${message}`);
    }
    completeEntry(debugEntry.id);
    return json.data.id;
  }
}

export const sessionPool = new SessionPool();
