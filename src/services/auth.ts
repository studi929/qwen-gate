import crypto from 'crypto';
import path from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, unlinkSync, watch, type FSWatcher } from 'fs';
import { getActivePage, getBrowser, createAccountContext } from './playwright.ts';
import { logStore } from './logStore.js';

const AUTH_FETCH_TIMEOUT_MS = parseInt(process.env.QWEN_FETCH_TIMEOUT_MS || '30000', 10);

function createAuthFetchTimeout(): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  return {
    controller,
    cleanup: () => clearTimeout(timeout),
  };
}

class LoginMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * Check if Playwright has an active browser session with auth cookies.
 * Used as fallback when Qwen's REST signin API returns 200 but no token.
 */
async function checkPlaywrightSession(): Promise<boolean> {
  try {
    const page = getActivePage();
    if (!page) return false;
    const cookies = await page.context().cookies();
    return cookies.some(c =>
      c.name.toLowerCase().includes('token') ||
      c.name.toLowerCase().includes('session')
    );
  } catch {
    return false;
  }
}

export interface AuthState {
  token: string;
  expiresAt: number;
  refreshToken: string | null;
}

export interface AccountEntry {
  email: string;
  password: string;
  state: AuthState | null;
  lastUsed: number;
  throttledUntil: number;
  refreshInFlight: Promise<boolean> | null;
  loginAttempt: number;
  /** Number of currently in-flight chat requests using this account */
  inFlight: number;
  /** Total chat requests processed by this account since startup */
  totalRequests: number;
}

const AUTH_TOKEN_MAX_AGE_MS = parseInt(process.env.AUTH_TOKEN_MAX_AGE_MS || String(60 * 60 * 1000), 10);
const AUTH_REFRESH_BEFORE_MS = parseInt(process.env.AUTH_REFRESH_BEFORE_MS || String(5 * 60 * 1000), 10);
const DEFAULT_THROTTLE_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || String(120_000), 10);

let accounts: AccountEntry[] = [];
let initDone = false;

function parseAccountsFromEnv(): Array<{ email: string; password: string }> {
  const result: Array<{ email: string; password: string }> = [];
  // Read ACCOUNT1, ACCOUNT2, ... ACCOUNTn from env
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^ACCOUNT\d+$/i.test(key) || !value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const email = trimmed.substring(0, colonIdx).trim();
    const password = trimmed.substring(colonIdx + 1).trim();
    if (email && password) {
      result.push({ email, password });
    }
  }
  return result;
}

function discoverSavedAccounts(): Array<{ email: string; password: string }> {
  try {
    const diskAccounts: Array<{ email: string; password: string }> = [];
    if (existsSync(COOKIE_DIR)) {
      const files = readdirSync(COOKIE_DIR).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data: CookieData = JSON.parse(readFileSync(path.join(COOKIE_DIR, file), 'utf-8'));
          if (data.email && data.token) {
            diskAccounts.push({ email: data.email, password: '' });
          }
        } catch (err) {
          console.error(`[Auth] Failed to parse saved account file ${file}:`, err);
        }
      }
    }

    // Merge env accounts: update passwords for existing, add new ones
    const envAccounts = parseAccountsFromEnv();
    const merged = [...diskAccounts];
    for (const envAcct of envAccounts) {
      const existing = merged.find(a => a.email.toLowerCase().trim() === envAcct.email.toLowerCase().trim());
      if (existing) {
        existing.password = envAcct.password;
      } else {
        merged.push({ email: envAcct.email, password: envAcct.password });
      }
    }

    return merged;
  } catch {
    return [];
  }
}

function isAvailable(acct: AccountEntry): boolean {
  if (!acct.state) return false;
  if (acct.throttledUntil > Date.now()) return false;
  return true;
}

function needsRefresh(acct: AccountEntry): boolean {
  if (!acct.state) return true;
  return acct.state.expiresAt - AUTH_REFRESH_BEFORE_MS < Date.now();
}

/**
 * Pick the best available account:
 *   1. Consider only available (non-throttled, authenticated) accounts
 *   2. Prefer idle accounts (no in-flight requests)
 *   3. Among idle (or all if all busy), pick the one with the lowest total request count
 *   4. If all are throttled, pick the one with the shortest remaining cooldown
 *
 * This distributes load evenly across all accounts over time.
 */
export function pickAccount(): AccountEntry | null {
  const available = accounts.filter(isAvailable);
  if (available.length === 0) {
    // All throttled — pick the one with shortest remaining cooldown
    if (accounts.length === 0) return null;
    const now = Date.now();
    let best: AccountEntry | null = null;
    for (const acct of accounts) {
      if (acct.state) {
        if (!best || acct.throttledUntil < best.throttledUntil) best = acct;
      }
    }
    return best;
  }

  // Prefer idle accounts (no in-flight requests); if all are busy, use all available
  const idle = available.filter(a => a.inFlight === 0);
  const candidates = idle.length > 0 ? idle : available;

  // Pick the one with the fewest total requests — equalizes distribution over time
  candidates.sort((a, b) => a.totalRequests - b.totalRequests);
  return candidates[0];
}

export function incrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.inFlight++;
}

export function decrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct && acct.inFlight > 0) acct.inFlight--;
}

export function incrementTotalRequests(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.totalRequests++;
}

/**
 * Helper to check if an account has in-flight requests.
 */
export function hasInFlight(email: string): boolean {
  const acct = getAccountByEmail(email);
  return acct ? acct.inFlight > 0 : false;
}

/**
 * Get a specific account by email.
 */
export function getAccountByEmail(email: string): AccountEntry | null {
  return accounts.find(a => a.email === email) || null;
}

/**
 * Get token from the best available account. Backward-compatible.
 */
export function getToken(): string | null {
  const acct = pickAccount();
  return acct?.state?.token || null;
}

/**
 * Get token and email for a specific account (or best available).
 * Call this when you need to track which account was used.
 */
export function getTokenWithAccount(email?: string): { token: string; email: string } | null {
  let acct: AccountEntry | null;
  if (email) {
    acct = getAccountByEmail(email);
    if (acct && !isAvailable(acct) && acct.state) {
      // Account exists but throttled — still return it (caller knows what they're doing)
    }
  } else {
    acct = pickAccount();
  }
  if (!acct?.state?.token) return null;
  acct.lastUsed = Date.now();
  return { token: acct.state.token, email: acct.email };
}

/**
 * Mark an account as throttled (rate-limited). It won't be selected for `durationMs`.
 */
export function throttleAccount(email: string, durationMs?: number): void {
  const acct = getAccountByEmail(email);
  if (!acct) return;
  const cooldown = durationMs || DEFAULT_THROTTLE_MS;
  acct.throttledUntil = Date.now() + cooldown;
  const remaining = Math.ceil(cooldown / 1000);
  console.warn(`[Auth] Throttled ${email} for ${remaining}s`);
}

/**
 * Check if a specific account is throttled.
 */
export function isAccountThrottled(email: string): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return true;
  return acct.throttledUntil > Date.now();
}

async function tryRefreshToken(acct: AccountEntry): Promise<boolean> {
  if (!acct.state?.refreshToken) return false;

  const { controller, cleanup } = createAuthFetchTimeout();
  try {
    const response = await fetch('https://chat.qwen.ai/api/v2/auths/refresh', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ refresh_token: acct.state.refreshToken }),
      signal: controller.signal,
    });

    if (response.ok) {
      const data = await response.json();
      if (data.data?.token) {
        acct.state = {
          token: data.data.token,
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken: data.data.refresh_token || acct.state.refreshToken,
        };
        await saveCookies(acct.email, acct.state.token, acct.state.refreshToken, acct.state.expiresAt);
        if (acct.throttledUntil > Date.now()) {
          acct.throttledUntil = 0;
        } else {
        }
        return true;
      }
    }

    console.error(`[Auth] HTTP refresh failed for ${acct.email} — falling back to profile-based refresh`);
    try {
      const { refreshViaProfile } = await import('./playwright.ts');
      const profileResult = await refreshViaProfile(acct.email);
      if (profileResult) {
        return true;
      }
    } catch (profileErr: any) {
      console.error(`[Auth] Profile refresh fallback failed for ${acct.email}:`, profileErr.message);
    }

    return false;
  } catch {
    try {
      const { refreshViaProfile } = await import('./playwright.ts');
      const profileResult = await refreshViaProfile(acct.email);
      if (profileResult) {
        console.error(`[Auth] ✓ Token refreshed via profile for ${acct.email} (after network error)`);
        return true;
      }
    } catch {}
    return false;
  } finally {
    cleanup();
  }
}

async function ensureAccountFresh(acct: AccountEntry): Promise<boolean> {
  if (acct.state && !needsRefresh(acct)) return true;

  // Avoid concurrent refresh for same account
  if (acct.refreshInFlight) {
    return acct.refreshInFlight;
  }

  acct.refreshInFlight = (async () => {
    try {
      if (acct.state?.refreshToken) {
        if (await tryRefreshToken(acct)) return true;
        console.warn(`[Auth] Refresh token failed for ${acct.email}`);
      }

      if (acct.throttledUntil > Date.now()) {
        const waitSec = Math.ceil((acct.throttledUntil - Date.now()) / 1000);
        console.warn(`[Auth] ⏳ Skipping re-login for ${acct.email} — throttled for ${waitSec}s more`);
        return false;
      }

      const newState = await loginFresh(acct.email, acct.password);
      if (newState) {
        acct.state = newState;
        return true;
      }
      return false;
    } finally {
      acct.refreshInFlight = null;
    }
  })();

  return acct.refreshInFlight;
}

// Lock to serialize browser-context logins (only one activePage, cookie clearing is global)
const loginMutex = new LoginMutex();

/**
 * Login via browser context — executes signin API inside the browser via evaluate().
 * This gives proper anti-bot/WAF headers and lets the browser capture Set-Cookie automatically.
 * After the call, we extract the token from both the response data and browser cookies.
 */
async function loginFreshViaBrowser(email: string, hashedPassword: string): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const page = getActivePage();
    if (!page) return null;

    // Ensure page is on the right origin for proper CORS/cookie handling
    try {
      const currentUrl = page.url();
      if (!currentUrl.startsWith('https://chat.qwen.ai')) {
        await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded' });
      }
    } catch (err: any) {
      console.warn(`[Auth] Navigation check failed for ${email}: ${err.message}`);
    }

    // Clear existing auth cookies for a clean slate (this is global to the browser context)
    try {
      const context = page.context();
      const existingCookies = await context.cookies();
      const authCookies = existingCookies.filter(c =>
        c.name === 'token' ||
        c.name === 'refresh_token' ||
        c.name.toLowerCase().includes('session') ||
        c.name.toLowerCase().includes('token')
      );
      if (authCookies.length > 0) {
        // clearCookies with specific domains — Playwright API: clearCookies(urls?)
        await context.clearCookies();
      }
    } catch (err: any) {
      console.warn(`[Auth] Cookie clearing failed for ${email}: ${err.message}`);
    }

    let evalResult: { ok: boolean; status: number; token: string | null; refreshToken: string | null; dataKeys: string[] };
    try {
      evalResult = await page.evaluate(async ({ email, hashedPassword }: { email: string; hashedPassword: string }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);
        let response: Response;
        try {
          response = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
            method: 'POST',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'source': 'web',
              'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
              'x-request-id': crypto.randomUUID(),
            },
            credentials: 'include',
            body: JSON.stringify({ email, password: hashedPassword }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        let data: any = {};
        try { data = await response.json(); } catch {} // expected — non-JSON responses fall back to empty data

        const token = data?.data?.token || data?.token || data?.data?.session_token || null;
        const refreshToken = data?.data?.refresh_token || data?.refresh_token || null;

        return {
          ok: response.ok,
          status: response.status,
          token: token as string | null,
          refreshToken: refreshToken as string | null,
          dataKeys: Object.keys(data),
        };
      }, { email, hashedPassword });
    } catch (err: any) {
      console.error(`[Auth] Browser evaluate failed for ${email}: ${err.message}`);
      return null;
    }

    if (!evalResult.ok) {
      console.error(`[Auth] Login failed for ${email} (${evalResult.status})`);
      return null;
    }

    // Extract token from browser cookies (the browser auto-captured Set-Cookie headers)
    let cookieToken: string | null = null;
    let cookieRefresh: string | null = null;
    try {
      const cookies = await page.context().cookies();
      const tokenCookie = cookies.find(c =>
        c.name === 'token' ||
        (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh'))
      );
      const refreshCookie = cookies.find(c =>
        c.name === 'refresh_token' ||
        (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen'))
      );
      cookieToken = tokenCookie?.value || null;
      cookieRefresh = refreshCookie?.value || null;
    } catch (err: any) {
      console.warn(`[Auth] Cookie read failed for ${email}: ${err.message}`);
    }

    // Prefer token from response body, fallback to cookie
    const finalToken = evalResult.token || cookieToken;
    const finalRefresh = evalResult.refreshToken || cookieRefresh;

    if (finalToken) {
      const state: AuthState = {
        token: finalToken,
        expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
        refreshToken: finalRefresh,
      };
      return state;
    }

    console.warn(
      `[Auth] Login returned 200 for ${email} but no token found. ` +
      `Response keys: [${evalResult.dataKeys.join(', ')}]. ` +
      `No auth cookies captured.`
    );
    return null;
  } finally {
    release();
  }
}

/**
 * Login via plain fetch — fallback for when Playwright is not available (test mode).
 */
async function loginFreshViaFetch(email: string, hashedPassword: string): Promise<AuthState | null> {
  const { controller, cleanup: _cleanup } = createAuthFetchTimeout();
  try {
    const response = await fetch('https://chat.qwen.ai/api/v2/auths/signin', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
        'Version': '0.2.57',
        'bx-v': '2.5.36',
        'Referer': 'https://chat.qwen.ai/auth',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ email, password: hashedPassword }),
      signal: controller.signal,
    });

    if (response.ok) {
      let data: any;
      try { data = await response.json(); } catch { data = {}; }

      let token = data.data?.token || data.token || data.data?.session_token || null;
      let refreshToken = data.data?.refresh_token || data.refresh_token || null;

      if (!token) {
        const hdrs = response.headers as Headers & { getSetCookie?: () => string[] };
        const setCookies: string[] = typeof hdrs.getSetCookie === 'function'
          ? hdrs.getSetCookie()
          : (response.headers.get('set-cookie') || '').split(',');

        for (const cookie of setCookies) {
          const tokenMatch = cookie.match(/\btoken=([^;]+)/);
          if (tokenMatch && !token) token = tokenMatch[1];
          const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
          if (refreshMatch) refreshToken = refreshMatch[1];
        }
      }

      if (token) {
        const state: AuthState = {
          token,
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken,
        };
        return state;
      }

      // In fetch fallback mode, check Playwright session as last resort
      const hasPlaywrightSession = await checkPlaywrightSession();
      if (hasPlaywrightSession) {
        return {
          token: '',
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken: null,
        };
      }

      console.warn(`[Auth] API login returned 200 but no token for ${email}:`, JSON.stringify(data).substring(0, 200));
    } else {
      const errText = await response.text();
      console.error(`[Auth] Login failed for ${email} (${response.status}): ${errText.substring(0, 200)}`);
    }
  } catch (err: any) {
    console.error(`[Auth] Login error for ${email}: ${err.message}`);
  }

  return null;
}

async function loginViaTempContext(
  _browser: ReturnType<typeof getBrowser>,
  email: string,
  rawPassword: string,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const accCtx = await createAccountContext(email);
    const page = accCtx.page;
    const context = accCtx.context;

    let capturedToken: string | null = null;
    let capturedRefresh: string | null = null;

    await page.route('**/api/v2/auths/signin', async (route) => {
      const response = await route.fetch();
      const setCookies = response.headersArray()
        .filter(h => h.name.toLowerCase() === 'set-cookie')
        .map(h => h.value);
      for (const cookie of setCookies) {
        const tokenMatch = cookie.match(/\btoken=([^;]+)/);
        if (tokenMatch && !capturedToken) capturedToken = tokenMatch[1];
        const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
        if (refreshMatch) capturedRefresh = refreshMatch[1];
      }
      await route.fulfill({ response });
    });

    try {
      await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {}

    try {
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15_000 });
      await page.fill('input[type="email"], input[name="email"]', email);
      await page.fill('input[type="password"], input[name="password"]', rawPassword);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")'),
        page.waitForURL(url => !url.toString().includes('/auth'), { timeout: 15_000 }).catch(() => {}),
      ]);
    } catch {}

    await new Promise(r => setTimeout(r, 2000));

    if (!capturedToken) {
      const cookies = await context.cookies();
      const tokenCookie = cookies.find(c =>
        c.name === 'token' ||
        (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh'))
      );
      const refreshCookie = cookies.find(c =>
        c.name === 'refresh_token' ||
        (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen'))
      );
      capturedToken = tokenCookie?.value || null;
      capturedRefresh = refreshCookie?.value || null;
    }

    await page.unroute('**/api/v2/auths/signin');

    if (capturedToken) {
      const state: AuthState = {
        token: capturedToken,
        expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
        refreshToken: capturedRefresh,
      };
      return state;
    }

    const cookies = await context.cookies();
    console.warn(
      `[Auth] Temp context login failed for ${email}. Cookies: ${cookies.map(c => c.name).join(', ')}`
    );
    return null;
  } catch (err: any) {
    console.error(`[Auth] Temp context login error for ${email}: ${err.message}`);
    return null;
  } finally {
    release();
  }
}

/**
 * Login an account — uses browser-context API calls when Playwright is active,
 * falls back to plain fetch for test/no-browser mode.
 */
export async function loginFresh(email: string, password: string): Promise<AuthState | null> {
  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  // Browser path: use getActivePage().evaluate() for proper WAF headers + cookie capture
  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    const activePage = getActivePage();
    if (activePage) {
      const browserResult = await loginFreshViaBrowser(email, hashedPassword);
      if (browserResult) {
        logStore.log('info', 'auth', 'Login success: ' + email);
        return browserResult;
      }
      console.warn(`[Auth] Browser login failed for ${email}, trying temp context...`);
    }

    // No active page at startup — create temporary browser context for login
    const browser = getBrowser();
    if (browser) {
      const tempResult = await loginViaTempContext(browser, email, password);
      if (tempResult) {
        logStore.log('info', 'auth', 'Login success (temp context): ' + email);
        return tempResult;
      }
      console.warn(`[Auth] Temp context login failed for ${email}, trying fetch fallback...`);
    }
  }

  // Fetch fallback: for test mode or when all browser paths fail
  const fetchResult = await loginFreshViaFetch(email, hashedPassword);
  if (fetchResult) {
    logStore.log('info', 'auth', 'Login success (fetch): ' + email);
  } else {
    logStore.log('error', 'auth', 'Login failed: ' + email);
  }
  return fetchResult;
}

export async function initAuth(): Promise<void> {
  if (initDone) return;
  initDone = true;

  const persisted = loadAccountsFromFile();
  const discovered = discoverSavedAccounts();

  const merged = [...discovered];
  for (const p of persisted) {
    const existing = merged.find(a => a.email.toLowerCase().trim() === p.email.toLowerCase().trim());
    if (existing) {
      // Cookie-discovered accounts have no password — restore it from persisted file
      if (p.password && !existing.password) {
        existing.password = p.password;
      }
    } else if (p.password) {
      merged.push(p);
    }
  }

  if (merged.length === 0) {
    console.warn('[Auth] No saved accounts found. Run: npm run login user@example.com');
    return;
  }

  accounts = merged.map((a: { email: string; password: string }) => ({
    email: a.email,
    password: a.password,
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
  }));

  // Login all accounts sequentially with delays between them.
  // Sequential is required because:
  // 1. Browser-context login uses shared activePage + global cookie jar
  // 2. Parallel requests trigger Qwen's WAF/anti-bot protection
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];

    const savedState = await loadSavedCookies(acct.email);
    if (savedState) {
      acct.state = savedState;
    } else if (acct.password) {
      const newState = await loginFresh(acct.email, acct.password);
      if (newState) {
        acct.state = newState;
        await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
      } else {
      }
    }

    if (i < accounts.length - 1) {
      await new Promise(r => setTimeout(r, acct.password && !acct.state ? 2000 : 1000));
    }
  }

  // Report results
  const successCount = accounts.filter(a => a.state !== null && a.state.token).length;
  logStore.log('info', 'auth', successCount + '/' + accounts.length + ' accounts authenticated');
  
  for (const acct of accounts) {
    const status = acct.state?.token ? '✓' : '✗';
  }

  setupAccountWatcher();
}

export async function autoLoginAllAccounts(): Promise<void> {
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    if (acct.state || !acct.password) continue;
    const newState = await loginFresh(acct.email, acct.password);
    if (newState) {
      acct.state = newState;
      await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
    } else {
    }
    if (i < accounts.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

/**
 * Ensure all accounts have valid tokens. Called periodically or before requests.
 */
export async function ensureAllFresh(): Promise<void> {
  const stale = accounts.filter(a => a.state && needsRefresh(a));
  if (stale.length === 0) return;
  await Promise.allSettled(stale.map(a => ensureAccountFresh(a)));
}

export function getAccountStats(): Array<{
  email: string;
  authenticated: boolean;
  throttled: boolean;
  throttledRemainingMs: number;
  tokenExpiresInMs: number;
  lastUsedAgoMs: number;
  inFlight: number;
  totalRequests: number;
}> {
  const now = Date.now();
  return accounts.map(a => ({
    email: a.email,
    authenticated: a.state !== null,
    throttled: a.throttledUntil > now,
    throttledRemainingMs: Math.max(0, a.throttledUntil - now),
    tokenExpiresInMs: a.state ? Math.max(0, a.state.expiresAt - now) : 0,
    lastUsedAgoMs: a.lastUsed ? now - a.lastUsed : -1,
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
  }));
}

export function getAccountCount(): number {
  return accounts.length;
}

export function getAvailableCount(): number {
  return accounts.filter(isAvailable).length;
}

export function getAllAccountEmails(): string[] {
  return accounts.map(a => a.email);
}

/**
 * Get a readonly copy of all accounts with email and password.
 * Passwords are included for admin/CRUD operations but should never be logged or returned to clients.
 */
export function getAccounts(): readonly AccountEntry[] {
  return [...accounts];
}

const COOKIE_DIR = 'qwen_profile/cookies';
const ACCOUNTS_FILE = 'qwen_profile/accounts.json';

function getCookieFilePath(email: string): string {
  const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return path.join(COOKIE_DIR, `${hash}.json`);
}

function getProfileDirForEmail(email: string): string {
  const safe = email.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  return path.join(process.cwd(), 'qwen_profile', 'chromium-profiles', safe);
}

interface CookieData {
  email: string;
  token: string;
  refreshToken: string | null;
  savedAt: number;
  expiresAt: number;
}

interface PersistedAccountData {
  email: string;
  password: string;
}

/**
 * Decode a JWT token and return its payload, or null if invalid.
 */
function decodeJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // JWT base64url → standard base64
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Load saved token for an account from disk. Called by initAuth.
 * Returns AuthState if a valid, non-expired token was found, null otherwise.
 * Checks both the local expiresAt timestamp AND the JWT's embedded `exp` claim.
 */
export async function loadSavedCookies(email: string): Promise<AuthState | null> {
  try {
    const filePath = getCookieFilePath(email);
    if (!existsSync(filePath)) return null;

    const raw = readFileSync(filePath, 'utf-8');
    const data: CookieData = JSON.parse(raw);

    if (!data.token || data.email.toLowerCase() !== email.toLowerCase()) return null;

    // JWT's embedded `exp` claim is authoritative — check it first
    const payload = decodeJwt(data.token);
    if (payload?.exp && payload.exp * 1000 < Date.now()) {
      return null;
    }

    // Local expiresAt is a secondary check (may be shorter than real JWT lifetime)
    if (data.expiresAt < Date.now()) {
    }

    return {
      token: data.token,
      expiresAt: data.expiresAt,
      refreshToken: data.refreshToken,
    };
  } catch (err: any) {
    console.warn(`[Auth] Failed to load saved cookies for ${email}: ${err.message}`);
    return null;
  }
}

/**
 * Save token for an account to disk. Called by login.ts after manual login.
 */
export async function saveCookies(email: string, token: string, refreshToken?: string | null, expiresAt?: number): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  try {
    if (!existsSync(COOKIE_DIR)) mkdirSync(COOKIE_DIR, { recursive: true });

    let jwtExpiresAt = expiresAt;
    if (!jwtExpiresAt) {
      const payload = decodeJwt(token);
      if (payload?.exp && typeof payload.exp === 'number') {
        jwtExpiresAt = payload.exp * 1000;
      } else {
        jwtExpiresAt = Date.now() + AUTH_TOKEN_MAX_AGE_MS;
      }
    }

    const data: CookieData = {
      email: normalizedEmail,
      token,
      refreshToken: refreshToken || null,
      savedAt: Date.now(),
      expiresAt: jwtExpiresAt,
    };

    writeFileSync(getCookieFilePath(normalizedEmail), JSON.stringify(data, null, 2), 'utf-8');

    const acct = accounts.find(a => a.email.toLowerCase().trim() === normalizedEmail);
    if (acct && token) {
      acct.state = {
        token,
        expiresAt: jwtExpiresAt,
        refreshToken: refreshToken || acct.state?.refreshToken || null,
      };
      if (acct.throttledUntil > Date.now()) {
        acct.throttledUntil = 0;
      }
    }

  } catch (err: any) {
    console.error(`[Auth] Failed to save cookies for ${normalizedEmail}: ${err.message}`);
  }
}

let accountWatcher: FSWatcher | null = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let watcherReady = false;

/**
 * Re-scan COOKIE_DIR and merge changes into the live accounts array.
 * - New files → add AccountEntry with counters at 0, load saved cookies
 * - Removed files → remove account UNLESS inFlight > 0
 * - Existing accounts → preserve inFlight and totalRequests counters
 */
export async function reloadAccounts(): Promise<void> {
  if (accountWatcher && !watcherReady) {
    return;
  }
  const discovered = discoverSavedAccounts();
  const discoveredEmails = new Set(discovered.map(d => d.email.toLowerCase().trim()));
  const existingEmails = new Set(accounts.map(a => a.email.toLowerCase().trim()));

  let added = 0;
  let removed = 0;

  for (const d of discovered) {
    const email = d.email.toLowerCase().trim();
    if (!existingEmails.has(email)) {
      const entry: AccountEntry = {
        email,
        password: d.password,
        state: null,
        lastUsed: 0,
        throttledUntil: 0,
        refreshInFlight: null,
        loginAttempt: 0,
        inFlight: 0,
        totalRequests: 0,
      };
      const savedState = await loadSavedCookies(email);
      if (savedState) {
        entry.state = savedState;
      }
      accounts.push(entry);
      added++;
    }
  }

  for (let i = accounts.length - 1; i >= 0; i--) {
    const acct = accounts[i];
    if (!discoveredEmails.has(acct.email.toLowerCase().trim())) {
      const cookieFile = getCookieFilePath(acct.email);
      if (existsSync(cookieFile)) {
        continue;
      }
      if (acct.inFlight > 0) {
        continue;
      }
      accounts.splice(i, 1);
      removed++;
    }
  }

  const unchanged = accounts.length - added;
}

/**
 * Set up fs.watch on COOKIE_DIR with 300ms debounce to detect account file changes.
 */
export function setupAccountWatcher(): void {
  if (accountWatcher) return;

  if (!existsSync(COOKIE_DIR)) {
    mkdirSync(COOKIE_DIR, { recursive: true });
  }

  try {
    accountWatcher = watch(COOKIE_DIR, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.json')) return;

      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        reloadDebounceTimer = null;
        reloadAccounts().catch(err => {
          console.error(`[Auth] Hot-reload failed: ${err.message}`);
        });
      }, 500);
    });

    accountWatcher.on('error', (err) => {
      console.error(`[Auth] Account watcher error: ${err.message}`);
      // Close the dead watcher so setupAccountWatcher() can re-create it
      try { accountWatcher?.close(); } catch {}
      accountWatcher = null;
      watcherReady = false;
      // Schedule restart in 10 seconds
      setTimeout(() => {
        setupAccountWatcher();
      }, 10000).unref();
    });

    setTimeout(() => { watcherReady = true; }, 2000);
  } catch (err: any) {
    console.error(`[Auth] Failed to set up account watcher: ${err.message}`);
  }
}

/**
 * Enable hot-reload by starting the account file watcher.
 * Called automatically at end of initAuth(), or manually via admin endpoint.
 */
export function enableHotReload(): void {
  setupAccountWatcher();
}

function saveAccountsToFile(): void {
  const dir = path.dirname(ACCOUNTS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const data: PersistedAccountData[] = accounts
    .filter(a => a.password)
    .map(a => ({ email: a.email, password: a.password }));
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function loadAccountsFromFile(): Array<{ email: string; password: string }> {
  try {
    if (!existsSync(ACCOUNTS_FILE)) {
      return [];
    }
    const data: PersistedAccountData[] = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    return data.filter(d => d.email && d.password);
  } catch (err: any) {
    console.error('[Auth] Failed to load accounts file:', err.message);
    return [];
  }
}

export async function addAccount(email: string, password: string): Promise<{ loginSucceeded: boolean; loginError?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = accounts.find(a => a.email.toLowerCase().trim() === normalizedEmail);
  if (existing) {
    throw new Error(`Account with email ${normalizedEmail} already exists`);
  }

  const entry: AccountEntry = {
    email: normalizedEmail,
    password,
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
  };

  accounts.push(entry);
  saveAccountsToFile();

  const newState = await loginFresh(normalizedEmail, password);
  if (newState) {
    entry.state = newState;
    await saveCookies(normalizedEmail, newState.token, newState.refreshToken, newState.expiresAt);
    return { loginSucceeded: true };
  } else {
    const msg = `Login failed: wrong password or CAPTCHA required for ${normalizedEmail}. Check system logs.`;
    console.warn(`[Auth] ${msg}`);
    return { loginSucceeded: false, loginError: msg };
  }
}

export async function removeAccount(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const index = accounts.findIndex(a => a.email.toLowerCase().trim() === normalizedEmail);
  if (index === -1) {
    throw new Error(`Account with email ${normalizedEmail} not found`);
  }

  accounts.splice(index, 1);
  saveAccountsToFile();

  const cookieFile = getCookieFilePath(normalizedEmail);
  if (existsSync(cookieFile)) {
    try {
      unlinkSync(cookieFile);
    } catch (err: any) {
      console.error(`[Auth] Failed to delete cookie file for ${normalizedEmail}:`, err.message);
    }
  }

  const profileDir = getProfileDirForEmail(normalizedEmail);
  if (existsSync(profileDir)) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (err: any) {
      console.error(`[Auth] Failed to delete Chromium profile for ${normalizedEmail}:`, err.message);
    }
  }

}

export function clearAuth(): void {
  accounts = [];
  initDone = false;
  watcherReady = false;
}

export async function ensureAuthenticated(): Promise<boolean> {
  if (accounts.length === 0) {
    await initAuth();
  }
  await ensureAllFresh();
  return accounts.some(a => a.state !== null);
}
