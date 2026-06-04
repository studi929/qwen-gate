import { chromium, firefox, webkit, BrowserContext, Page, Cookie, Browser } from 'playwright';
import { launch as cloakLaunch } from 'cloakbrowser';
import crypto from 'crypto';
import { getTokenWithAccount, pickAccount } from "./auth.ts";
import { logStore } from './logStore.ts';
export { getProfileDir, openBrowserProfile, refreshViaProfile, autoFillLogin } from './browserProfiles.ts';
export type { LoginResult, BrowserProfileOptions } from './browserProfiles.ts';
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
const COOKIE_REFRESH_INTERVAL = 30 * 1000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function validateQwenUrl(url: string): void {
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
    for (const accCtx of accountContexts.values()) {
      const cookies = await accCtx.context.cookies();
      cachedCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      lastCookiesTime = Date.now();
      return cachedCookies!;
    }
    return '';
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
    for (const accCtx of accountContexts.values()) {
      cachedUserAgent = await Promise.race([
        accCtx.page.evaluate(() => navigator.userAgent),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('UserAgent timeout')), 10_000)),
      ]);
      break;
    }
    if (!cachedUserAgent) {
      cachedUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    }
  }
  let cookieStr = await getCookies(email);
  const tokenInfo = getTokenWithAccount(email);
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
export async function createAccountContext(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { context: null as unknown as BrowserContext, page: null as unknown as Page, lastRefresh: Date.now(), cookies: cookies || {}, headers: {} };
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
  }, COOKIE_REFRESH_INTERVAL);
  return accCtx;
}
export async function refreshAccountCookies(email: string): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  const accCtx = accountContexts.get(email);
  if (!accCtx) return;
  const { context, page } = accCtx;
  try {
    const cookies = await context.cookies();
    const hasAuthCookie = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
    if (!hasAuthCookie) {
      validateQwenUrl('https://chat.qwen.ai/');
      await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      const postCookies = await context.cookies();
      const hasPostAuth = postCookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
      if (!hasPostAuth) {
        logStore.log('warn', 'account', `${email} still has no auth cookie after navigation - token invalid, marking unavailable`);
        const { throttleAccount } = await import('./auth.ts');
        throttleAccount(email, 120_000);
        accCtx.cookies = {};
        accCtx.lastRefresh = Date.now();
        return;
      }
      postCookies.splice(0, postCookies.length, ...postCookies);
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
export function setCachedCookies(cookies: string, timestamp: number) { cachedCookies = cookies; lastCookiesTime = timestamp; }
export function setCachedUserAgent(ua: string) { cachedUserAgent = ua; }
export async function injectCookies(email: string, cookies: Array<{name: string, value: string, domain?: string, path?: string}>) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  const accCtx = accountContexts.get(email);
  if (!accCtx) throw new Error(`No context for account ${email}`);
  await accCtx.context.addCookies(cookies);
  accCtx.lastRefresh = Date.now();
  cachedCookies = null;
  lastCookiesTime = 0;
}
export function getActivePage(email?: string): Page | null {
  if (email) return accountContexts.get(email)?.page || null;
  for (const accCtx of accountContexts.values()) { return accCtx.page; }
  return null;
}
export function getBrowserContext(email?: string): BrowserContext | null {
  if (!email) return null;
  return accountContexts.get(email)?.context || null;
}
export function getBrowser(): Browser | null {
  return defaultBrowser || null;
}
export async function loginToQwen(email: string, password: string): Promise<boolean> {
  if (!getActivePage()) throw new Error('Playwright not initialized');
  const release = await uiMutex.acquire();
  try {
    const page = getActivePage()!;
    validateQwenUrl('https://chat.qwen.ai/auth');
    await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    const result = await page.evaluate(async ({ email, password }) => {
      try {
        const response = await fetch("https://chat.qwen.ai/api/v2/auths/signin", {
          method: "POST",
          headers: {
            "accept": "application/json, text/plain, */*",
            "content-type": "application/json",
            "source": "web",
            "timezone": new Date().toString().split(' (')[0],
            "x-request-id": crypto.randomUUID()
          },
          body: JSON.stringify({ email, password })
        });
        const data = await response.json();
        return { ok: response.ok, data };
      } catch (e: any) { return { ok: false, error: e.message }; }
    }, { email, password: hashedPassword });
    if (result.ok) {
      validateQwenUrl('https://chat.qwen.ai/');
      await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
      const isLogged = !(page.url().includes('auth') || page.url().includes('login'));
      if (isLogged) return true;
    }
    console.error('[Playwright] Login failed:', result.data || result.error);
    return false;
  } finally { release(); }
}
async function captureBxHeaders(accCtx: AccountContext): Promise<void> {
  try {
    await accCtx.page.evaluate(async () => {
      await fetch('https://chat.qwen.ai/api/v2/models', {
        method: 'GET',
        headers: { 'accept': 'application/json', 'source': 'web' },
      }).catch(() => {});
    });
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
  const targetEmail = email || pickAccount()?.email;
  if (!targetEmail) throw new Error('No account available for header extraction');
  let accCtx = accountContexts.get(targetEmail);
  if (!accCtx) {
    const tokenInfo = getTokenWithAccount(targetEmail);
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
}
