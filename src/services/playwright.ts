import { chromium, firefox, webkit, BrowserContext, Page, Cookie, Browser } from 'playwright';
import { launch as cloakLaunch } from 'cloakbrowser';
import crypto from 'crypto';
import { logStore } from './logStore.ts';
export { getProfileDir, openBrowserProfile, refreshViaProfile } from './browserProfiles.ts';
export type { LoginResult, BrowserProfileOptions } from './browserProfiles.ts';

const QWEN_BASE_URL = 'https://chat.qwen.ai';
export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';
export interface AccountContext {
  context: BrowserContext;
  page: Page;
  lastRefresh: number;
  cookies: Record<string, string>;
  headers: Record<string, string>;
  refreshInterval?: NodeJS.Timeout;
}
const accountContexts = new Map<string, AccountContext>();
const contextCreationInFlight = new Map<string, Promise<AccountContext>>();
let defaultBrowser: any = null;
let initInFlight: Promise<void> | null = null;
let cachedUserAgent: string | null = null;
let cachedCookies: string | null = null;
let lastCookiesTime = 0;
const COOKIES_TTL = 30 * 1000;
let cookiesInFlight: Promise<string> | null = null;
const COOKIE_REFRESH_INTERVAL = 120 * 1000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export function validateQwenUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Blocked URL protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '0.0.0.0') {
    throw new Error(`Blocked loopback URL: ${url}`);
  }
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
      /^192\.168\.\d+\.\d+$/.test(hostname)) {
    throw new Error(`Blocked private IP URL: ${url}`);
  }
}
export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => { resolve(() => this.release()); });
    });
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.locked = false; }
  }
}
const uiMutex = new Mutex();
export async function getCookies(email?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  if (email) {
    const accCtx = accountContexts.get(email);
    if (!accCtx) return '';
    const cookies = await accCtx.context.cookies();
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }
  if (cachedCookies && (Date.now() - lastCookiesTime < COOKIES_TTL)) {
    return cachedCookies;
  }
  if (cookiesInFlight) return cookiesInFlight;
  cookiesInFlight = (async () => {
    if (cachedCookies && (Date.now() - lastCookiesTime < COOKIES_TTL)) {
      return cachedCookies;
    }
    const allCookieStrings: string[] = [];
    for (const accCtx of accountContexts.values()) {
      const cookies = await accCtx.context.cookies();
      allCookieStrings.push(cookies.map(c => `${c.name}=${c.value}`).join('; '));
    }
    cachedCookies = allCookieStrings.join('; ');
    lastCookiesTime = Date.now();
    return cachedCookies;
  })().finally(() => { cookiesInFlight = null; });
  return cookiesInFlight;
}
export interface BasicHeaders {
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUmidtoken: string;
  bxUa: string;
  email?: string;
}
export async function getBasicHeaders(email?: string): Promise<BasicHeaders> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { cookie: 'token=mock', userAgent: 'mock', bxV: '2.5.36', bxUmidtoken: '', bxUa: '', email: 'mock@test' };
  await initPlaywright();
    if (!cachedUserAgent) {
    try {
      for (const accCtx of accountContexts.values()) {
        cachedUserAgent = await Promise.race([
          accCtx.page.evaluate(() => navigator.userAgent),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error('UserAgent timeout')), 10_000)),
        ]);
        break;
      }
    } catch (err) {
      console.error('[Playwright] UserAgent extraction failed:', err);
    }
    if (!cachedUserAgent) {
      cachedUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    }
  }
  let cookieStr = await getCookies(email);
  const { getTokenWithAccount } = await import('./auth.ts');
  const tokenInfo = await getTokenWithAccount(email);
  if (tokenInfo) {
    const tokenEntry = `token=${tokenInfo.token}`;
    cookieStr = tokenEntry + (cookieStr ? '; ' + cookieStr : '');
  }
  const bxV = '2.5.36';
  let bxUmidtoken = '';
  let bxUa = '';
  if (email) {
    const accCtx = accountContexts.get(email);
    if (accCtx?.headers) {
      bxUmidtoken = accCtx.headers['bx-umidtoken'] || '';
      bxUa = accCtx.headers['bx-ua'] || '';
    }
  }
  return { cookie: cookieStr, userAgent: cachedUserAgent, bxV, bxUmidtoken, bxUa, email: tokenInfo?.email };
}
export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (defaultBrowser) return;
  if (initInFlight) { await initInFlight; return; }
  initInFlight = (async () => {
    if (defaultBrowser) return;
    let browserEngine: any;
    let channel: string | undefined;
    switch (browserType) {
      case 'firefox': browserEngine = firefox; break;
      case 'webkit': browserEngine = webkit; break;
      case 'chrome': browserEngine = chromium; channel = 'chrome'; break;
      case 'edge': browserEngine = chromium; channel = 'msedge'; break;
      case 'chromium':
      default:
        defaultBrowser = await cloakLaunch({
          headless,
          humanize: true,
          geoip: true,
          args: [
            '--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-popup-blocking', '--mute-audio', '--no-first-run',
            '--disable-background-networking', '--disable-default-apps',
            '--disable-sync', '--disable-translate', '--metrics-recording-only',
            '--disable-blink-features=AutomationControlled',
          ],
        });
        break;
    }
    if (browserEngine) {
      defaultBrowser = await browserEngine.launch({
        headless, channel,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
      });
    }
    const cleanupAllContexts = async () => {
      for (const [_email, accCtx] of accountContexts.entries()) {
        if (accCtx.refreshInterval) clearInterval(accCtx.refreshInterval);
        await accCtx.context.close();
      }
      accountContexts.clear();
      if (defaultBrowser) { await defaultBrowser.close(); defaultBrowser = null; }
    };
    process.on('exit', () => {});
    process.on('SIGTERM', cleanupAllContexts);
    process.on('SIGINT', cleanupAllContexts);
  })().finally(() => { initInFlight = null; });
  return initInFlight;
}
function typedCast<T>(v: unknown): T { return v as T; }

export async function createAccountContext(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { context: typedCast<BrowserContext>(null), page: typedCast<Page>(null), lastRefresh: Date.now(), cookies: cookies || {}, headers: {} };
  }
  const existing = accountContexts.get(email);
  if (existing) return existing;
  const inFlight = contextCreationInFlight.get(email);
  if (inFlight) return inFlight;
  const creationPromise = createContextInternal(email, cookies);
  contextCreationInFlight.set(email, creationPromise);
  try { return await creationPromise; } finally { contextCreationInFlight.delete(email); }
}
async function createContextInternal(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  await initPlaywright();
  if (!defaultBrowser) throw new Error('Playwright browser not initialized');
  if (accountContexts.has(email)) return accountContexts.get(email)!;
  const context = await defaultBrowser.newContext({
    storageState: cookies ? { cookies: Object.entries(cookies).map(([name, value]) => ({
      name, value, domain: '.qwen.ai', path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true, secure: true, sameSite: 'Lax'
    } as Cookie)), origins: [] } : undefined
  });
  const page = await context.newPage();
  const extractedHeaders: Record<string, string> = {};
  await page.route('**/api/**', async (route: any, request: any) => {
    const headers = request.headers();
    if (headers['bx-umidtoken']) extractedHeaders['bx-umidtoken'] = headers['bx-umidtoken'];
    if (headers['bx-ua']) extractedHeaders['bx-ua'] = headers['bx-ua'];
    if (headers['user-agent']) extractedHeaders['user-agent'] = headers['user-agent'];
    await route.continue();
  });
  await page.route('**/*', (route: any) => {
    const resourceType = route.request().resourceType();
    const url = route.request().url();
    if (resourceType === 'image' || resourceType === 'font' || resourceType === 'stylesheet' || resourceType === 'media') {
      route.abort();
    } else if (url.includes('google-analytics.com') || url.includes('googletagmanager.com') ||
               url.includes('facebook.com') || url.includes('hotjar.com') || url.includes('sentry.io')) {
      route.abort();
    } else {
      route.continue();
    }
  });
  if (cookies) {
    const cookieList = Object.entries(cookies).map(([name, value]) => ({
      name, value, domain: 'chat.qwen.ai', path: '/', secure: true, httpOnly: true
    }));
    await context.addCookies(cookieList);
  }
  const accCtx: AccountContext = { context, page, lastRefresh: Date.now(), cookies: cookies || {}, headers: extractedHeaders };
  accountContexts.set(email, accCtx);
  accCtx.refreshInterval = setInterval(async () => {
    try { await refreshAccountCookies(email); } catch (err) {
      console.error(`[AccountContext] Refresh failed for ${email}:`, err);
    }
  }, COOKIE_REFRESH_INTERVAL + Math.random() * 30000);
  return accCtx;
}
export async function refreshAccountCookies(email: string): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  const accCtx = accountContexts.get(email);
  if (!accCtx) return;
  const { context, page } = accCtx;
  try {
    // Ensure the account's JWT token is injected as a cookie in the browser context
    const { getAccountByEmail } = await import('./auth.ts');
    const acct = getAccountByEmail(email);
    if (acct?.state?.token) {
      const existingCookies = await context.cookies();
      const hasTokenCookie = existingCookies.some(c => c.name === 'token' && c.value === acct.state!.token);
      if (!hasTokenCookie) {
        await context.addCookies([{
          name: 'token',
          value: acct.state.token,
          domain: '.qwen.ai',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        }]);
      }
    }

    const cookies = await context.cookies();
    const hasAuthCookie = cookies.some(c => {
      const n = c.name.toLowerCase();
      if (n.includes('refresh')) return false;
      return n.includes('token') || n.includes('session');
    });
    if (!hasAuthCookie) {
      validateQwenUrl('https://chat.qwen.ai/');
      await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      const postCookies = await context.cookies();
      const hasPostAuth = postCookies.some(c => {
        const n = c.name.toLowerCase();
        if (n.includes('refresh')) return false;
        return n.includes('token') || n.includes('session');
      });
      if (!hasPostAuth) {
        // Only throttle if we don't have a valid token in memory
        if (!acct?.state?.token || (acct.state.expiresAt && acct.state.expiresAt < Date.now())) {
          logStore.log('warn', 'account', `${email} has no auth cookie and no valid token - marking unavailable`);
          const { throttleAccount } = await import('./auth.ts');
          throttleAccount(email, 60_000);
        } else {
          logStore.log('info', 'account', `${email} has valid token in memory but no browser cookie - will use token directly`);
        }
        accCtx.cookies = {};
        accCtx.lastRefresh = Date.now();
        return;
      }
    }
    const freshCookies = await context.cookies();
    const cookieRecord: Record<string, string> = {};
    for (const c of freshCookies) { cookieRecord[c.name] = c.value; }
    accCtx.cookies = cookieRecord;
    accCtx.lastRefresh = Date.now();
  } catch (err) {
    console.error(`[AccountContext] Refresh error for ${email}:`, err);
  }
}
export function removeAccountContext(email: string): void {
  const accCtx = accountContexts.get(email);
  if (!accCtx) return;
  if (accCtx.refreshInterval) {
    clearInterval(accCtx.refreshInterval);
  }
  accCtx.context.close().catch(() => {});
  accountContexts.delete(email);
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  for (const [_email, accCtx] of accountContexts.entries()) {
    if (accCtx.refreshInterval) clearInterval(accCtx.refreshInterval);
    await accCtx.context.close();
  }
  accountContexts.clear();
  if (defaultBrowser) { await defaultBrowser.close(); defaultBrowser = null; }
  cachedUserAgent = null;
  cachedCookies = null;
  lastCookiesTime = 0;
}
export function getCachedUserAgent(): string | null { return cachedUserAgent; }
export function getCachedCookies(): string | null { return cachedCookies; }
export function getLastCookiesTime(): number { return lastCookiesTime; }
export function getActivePage(email?: string): Page | null {
  if (email) return accountContexts.get(email)?.page || null;
  for (const accCtx of accountContexts.values()) { return accCtx.page; }
  return null;
}
export function getBrowser(): Browser | null {
  return defaultBrowser || null;
}
async function captureBxHeaders(accCtx: AccountContext): Promise<void> {
  try {
    await accCtx.page.evaluate(async (baseUrl) => {
      await fetch(`${baseUrl}/api/v2/models`, {
        method: 'GET',
        headers: { 'accept': 'application/json', 'source': 'web' },
      }).catch(() => {});
    }, QWEN_BASE_URL);
    await sleep(500);
  } catch (err: any) {
    console.warn(`[AccountContext] bx-header capture fetch failed: ${err.message}`);
  }
}
export async function getQwenHeaders(email?: string): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return {
      headers: {
        'bx-umidtoken': 'mock-umid-' + crypto.randomUUID().slice(0, 8),
        'bx-ua': 'mock-ua-' + crypto.randomUUID().slice(0, 8),
        'user-agent': 'mock-user-agent',
        'cookie': 'token=mock'
      },
      chatSessionId: 'mock-session-' + crypto.randomUUID().slice(0, 8),
      parentMessageId: null
    };
  }
  await initPlaywright();
  const { pickAccount, decrementInFlight, getTokenWithAccount } = await import('./auth.ts');
  const pickedFromPool = !email;
  const targetEmail = email || (await pickAccount())?.email;
  if (!targetEmail) throw new Error('No account available for header extraction');
  try {
    let accCtx = accountContexts.get(targetEmail);
    if (!accCtx) {
      const tokenInfo = await getTokenWithAccount(targetEmail);
      const initialCookies = tokenInfo?.token ? { token: tokenInfo.token } : undefined;
      accCtx = await createAccountContext(targetEmail, initialCookies);
      await refreshAccountCookies(targetEmail);
      await captureBxHeaders(accCtx);
      accCtx = accountContexts.get(targetEmail)!;
    } else if (Date.now() - accCtx.lastRefresh > COOKIE_REFRESH_INTERVAL) {
      await refreshAccountCookies(targetEmail);
      accCtx = accountContexts.get(targetEmail)!;
    }
    const cookies = await accCtx.context.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const headers: Record<string, string> = { ...accCtx.headers, 'cookie': cookieStr };
    accCtx.headers = headers;
    accCtx.lastRefresh = Date.now();
    const chatSessionId = crypto.randomUUID();
    return { headers, chatSessionId, parentMessageId: null };
  } finally {
    if (pickedFromPool) decrementInFlight(targetEmail);
  }
}
