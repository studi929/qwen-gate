import { chromium, firefox, webkit, BrowserContext, Page, Cookie, Browser } from 'playwright';
import path from 'path';
import crypto from 'crypto';
import { mkdirSync } from 'fs';
import { getToken, getTokenWithAccount, ensureAuthenticated, pickAccount } from './auth.ts';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

// Per-account isolated browser contexts
export interface AccountContext {
  context: BrowserContext;
  page: Page;
  lastRefresh: number;
  cookies: Record<string, string>;
  headers: Record<string, string>;
  refreshInterval?: NodeJS.Timeout;
}

const accountContexts = new Map<string, AccountContext>();
// Deduplicate concurrent createAccountContext calls for the same email.
// Without this, two simultaneous requests for the same account create duplicate
// BrowserContexts — wasting resources and corrupting cookie/header state.
const contextCreationInFlight = new Map<string, Promise<AccountContext>>();
let defaultBrowser: any = null; // Shared browser instance for creating contexts
let initInFlight: Promise<void> | null = null;
// P0: Cached values for getBasicHeaders() — avoids 2 async CDP calls per invocation
let cachedUserAgent: string | null = null;
let cachedCookies: string | null = null;
let lastCookiesTime = 0;
const COOKIES_TTL = 30 * 1000; // 30 seconds — cookies change rarely
let cookiesInFlight: Promise<string> | null = null;

// Cookie refresh interval (30s)
const COOKIE_REFRESH_INTERVAL = 30 * 1000;
// Context cleanup TTL (30min inactivity)
const CONTEXT_CLEANUP_TTL = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// SSRF prevention: validate URLs before passing to page.goto().
// Blocks file://, localhost, private IPs, and empty/malformed URLs.
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

/**
 * Get persistent profile directory for an account.
 * Sanitizes email to filesystem-safe name: youssefbue@gmail.com → youssefbue_gmail_com
 */
export function getProfileDir(email: string): string {
  const safe = email.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  const dir = path.join(process.cwd(), 'qwen_profile', 'chromium-profiles', safe);
  mkdirSync(dir, { recursive: true });
  return dir;
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

// Lock to prevent concurrent UI interactions
const uiMutex = new Mutex();

export async function getCookies(email?: string): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  
  // If email specified, get cookies from that account's context ONLY — never from global cache
  if (email) {
    const accCtx = accountContexts.get(email);
    if (!accCtx) return '';
    const cookies = await accCtx.context.cookies();
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }
  
  // Fallback: get cookies from any available context (with global cache)
  if (cachedCookies && (Date.now() - lastCookiesTime < COOKIES_TTL)) {
    return cachedCookies;
  }
  if (cookiesInFlight) return cookiesInFlight;
  cookiesInFlight = (async () => {
    if (cachedCookies && (Date.now() - lastCookiesTime < COOKIES_TTL)) {
      return cachedCookies;
    }
    // Get first available context
    for (const accCtx of accountContexts.values()) {
      const cookies = await accCtx.context.cookies();
      cachedCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      lastCookiesTime = Date.now();
      return cachedCookies!;
    }
    return '';
  })().finally(() => {
    cookiesInFlight = null;
  });
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
  
  // P0: Use cached userAgent (never changes during browser lifetime)
  if (!cachedUserAgent) {
    // Get userAgent from any available context
    for (const accCtx of accountContexts.values()) {
      cachedUserAgent = await accCtx.page.evaluate(() => navigator.userAgent, { timeout: 10_000 } as any);
      break;
    }
    if (!cachedUserAgent) {
      cachedUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    }
  }
  
  let cookieStr = await getCookies(email);

  // Inject auth token from our auth service into the cookie if present
  const tokenInfo = getTokenWithAccount(email);
  if (tokenInfo) {
    const tokenEntry = `token=${tokenInfo.token}`;
    cookieStr = tokenEntry + (cookieStr ? '; ' + cookieStr : '');
  }

  const bxV = '2.5.36';

  // Extract bx-headers from the per-account context (already captured by route handler)
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
  if (defaultBrowser) {
    return;
  }
  // Dedupe: if another caller is already initializing, wait for it
  if (initInFlight) {
    await initInFlight;
    return;
  }
  initInFlight = (async () => {
    // Re-check after acquiring — another caller may have finished while we waited
    if (defaultBrowser) return;

  let browserEngine;
  let channel: string | undefined;

  switch (browserType) {
    case 'firefox':
      browserEngine = firefox;
      break;
    case 'webkit':
      browserEngine = webkit;
      break;
    case 'chrome':
      browserEngine = chromium;
      channel = 'chrome';
      break;
    case 'edge':
      browserEngine = chromium;
      channel = 'msedge';
      break;
    case 'chromium':
    default:
      browserEngine = chromium;
      break;
  }

  console.log(`[Playwright] Launching ${browserType}...`);

  // Launch shared browser instance (not persistent context) for creating isolated contexts per account
  defaultBrowser = await browserEngine.launch({
    headless,
    channel,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled'
    ]
  });

  // Setup cleanup handlers for graceful shutdown
  const cleanupAllContexts = async () => {
    console.log('[AccountContext] Cleaning up all browser contexts...');
    for (const [email, accCtx] of accountContexts.entries()) {
      if (accCtx.refreshInterval) clearInterval(accCtx.refreshInterval);
      await accCtx.context.close();
      console.log(`[AccountContext] Closed ${email}`);
    }
    accountContexts.clear();
    if (defaultBrowser) {
      await defaultBrowser.close();
      defaultBrowser = null;
    }
  };
  process.on('exit', () => { /* sync cleanup not possible, rely on SIGTERM */ });
  process.on('SIGTERM', cleanupAllContexts);
  process.on('SIGINT', cleanupAllContexts);

  console.log('[AccountContext] Browser initialized, contexts will be created on-demand');

  console.log('[AccountContext] Browser initialized, contexts will be created on-demand');
  })().finally(() => {
    initInFlight = null;
  });
  return initInFlight;
}

/**
 * Create a new isolated BrowserContext for a specific account
 */
export async function createAccountContext(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    // Mock context for testing
    return {
      context: null as any,
      page: null as any,
      lastRefresh: Date.now(),
      cookies: cookies || {},
      headers: {}
    };
  }
  
  // Fast path: context already exists
  const existing = accountContexts.get(email);
  if (existing) return existing;

  // Deduplicate concurrent creation: if another call is already creating
  // a context for the same email, join that promise instead of creating a duplicate.
  const inFlight = contextCreationInFlight.get(email);
  if (inFlight) return inFlight;

  const creationPromise = createContextInternal(email, cookies);
  contextCreationInFlight.set(email, creationPromise);

  try {
    const ctx = await creationPromise;
    return ctx;
  } finally {
    contextCreationInFlight.delete(email);
  }
}

async function createContextInternal(email: string, cookies?: Record<string, string>): Promise<AccountContext> {
  await initPlaywright();
  if (!defaultBrowser) throw new Error('Playwright browser not initialized');
  
  // Double-check after init: another concurrent call may have created it while we waited
  if (accountContexts.has(email)) {
    return accountContexts.get(email)!;
  }
  
  console.log(`[AccountContext] Creating context for ${email}`);
  
  // Create new isolated context with storage state if cookies provided
  const context = await defaultBrowser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    storageState: cookies ? { cookies: Object.entries(cookies).map(([name, value]) => ({
      name,
      value,
      domain: '.qwen.ai',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    } as Cookie)), origins: [] } : undefined
  });
  
  // Bypass navigator.webdriver detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });
  
  const page = await context.newPage();
  
  // Setup header extraction via page.route
  const extractedHeaders: Record<string, string> = {};
  const routeHandler = async (route: any, request: any) => {
    const headers = request.headers();
    if (headers['bx-umidtoken']) extractedHeaders['bx-umidtoken'] = headers['bx-umidtoken'];
    if (headers['bx-ua']) extractedHeaders['bx-ua'] = headers['bx-ua'];
    if (headers['user-agent']) extractedHeaders['user-agent'] = headers['user-agent'];
    await route.continue();
  };
  await page.route('**/api/**', routeHandler);
  
  // Inject initial cookies if provided
  if (cookies) {
    const cookieList = Object.entries(cookies).map(([name, value]) => ({
      name,
      value,
      domain: 'chat.qwen.ai',
      path: '/',
      secure: true,
      httpOnly: true
    }));
    await context.addCookies(cookieList);
  }
  
  const accCtx: AccountContext = {
    context,
    page,
    lastRefresh: Date.now(),
    cookies: cookies || {},
    headers: extractedHeaders
  };
  
  accountContexts.set(email, accCtx);
  console.log(`[AccountContext] Created ${email}`);
  
  // Start auto-refresh interval for cookies (every 30s)
  accCtx.refreshInterval = setInterval(async () => {
    try {
      await refreshAccountCookies(email);
    } catch (err) {
      console.error(`[AccountContext] Refresh failed for ${email}:`, err);
    }
  }, COOKIE_REFRESH_INTERVAL);
  
  return accCtx;
}

/**
 * Refresh cookies for a specific account context without full navigation
 */
export async function refreshAccountCookies(email: string): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  
  const accCtx = accountContexts.get(email);
  if (!accCtx) return;
  
  const { context, page } = accCtx;
  
  try {
    // Check if context is still valid by checking cookies
    const cookies = await context.cookies();
    const hasAuthCookie = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
    
    if (!hasAuthCookie) {
      // Context expired, need to navigate to refresh
      console.log(`[AccountContext] Context expired for ${email}, navigating to refresh`);
      validateQwenUrl('https://chat.qwen.ai/');
      await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);

      // Re-check if we got an auth cookie after navigation
      const postCookies = await context.cookies();
      const hasPostAuth = postCookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
      if (!hasPostAuth) {
        console.warn(`[AccountContext] ${email} still has no auth cookie after navigation - token invalid, marking unavailable`);
        const { throttleAccount } = await import('./auth.ts');
        throttleAccount(email, 120_000);
        accCtx.cookies = {};
        accCtx.lastRefresh = Date.now();
        return;
      }
      // Use post-navigation cookies
      postCookies.splice(0, postCookies.length, ...postCookies);
    }
    
    // Fetch fresh cookies
    const freshCookies = await context.cookies();
    const cookieRecord: Record<string, string> = {};
    for (const c of freshCookies) {
      cookieRecord[c.name] = c.value;
    }
    
    // Update the account context
    accCtx.cookies = cookieRecord;
    accCtx.lastRefresh = Date.now();
    
    console.log(`[AccountContext] Refreshed ${email} (${freshCookies.length} cookies)`);
  } catch (err) {
    console.error(`[AccountContext] Refresh error for ${email}:`, err);
    // Don't throw - let the interval continue, next attempt may succeed
  }
}

async function checkValidSession(email: string): Promise<boolean> {
  const accCtx = accountContexts.get(email);
  if (!accCtx) return false;
  try {
    const cookies = await accCtx.context.cookies();
    const hasAuthCookie = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
    if (!hasAuthCookie) return false;
    validateQwenUrl('https://chat.qwen.ai/');
    await accCtx.page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const isLogged = !accCtx.page.url().includes('auth') && !accCtx.page.url().includes('login');
    return isLogged;
  } catch {
    return false;
  }
}

async function attemptAutoLogin(): Promise<void> {
  const email = process.env.QWEN_EMAIL;
  const password = process.env.QWEN_PASSWORD;
  if (!email || !password) return;
  console.log('[Playwright] Attempting auto-login with credentials from .env...');
  try {
    const success = await loginToQwen(email, password);
    if (success) {
      console.log('[Playwright] Auto-login successful.');
      return;
    }
    console.warn('[Playwright] API login failed, trying UI fallback...');
    const uiSuccess = await loginToQwenUI(email, password);
    if (uiSuccess) {
      console.log('[Playwright] UI login fallback successful.');
    } else {
      console.warn('[Playwright] Both API and UI login failed. Manual login may be required.');
    }
  } catch (err: any) {
    console.error('[Playwright] Auto-login error:', err.message);
  }
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  console.log('[AccountContext] Cleaning up all browser contexts...');
  for (const [email, accCtx] of accountContexts.entries()) {
    if (accCtx.refreshInterval) clearInterval(accCtx.refreshInterval);
    await accCtx.context.close();
    console.log(`[AccountContext] Closed ${email}`);
  }
  accountContexts.clear();
  if (defaultBrowser) {
    await defaultBrowser.close();
    defaultBrowser = null;
  }
  // Reset cached values so they are refetched on next getBasicHeaders() call
  cachedUserAgent = null;
  cachedCookies = null;
  lastCookiesTime = 0;
  console.log('[AccountContext] All contexts closed');
}

// P0: Expose cached values for external use (e.g., sessionPool)
export function getCachedUserAgent(): string | null {
  return cachedUserAgent;
}

export function getCachedCookies(): string | null {
  return cachedCookies;
}

export function getLastCookiesTime(): number {
  return lastCookiesTime;
}

export function setCachedCookies(cookies: string, timestamp: number) {
  cachedCookies = cookies;
  lastCookiesTime = timestamp;
}

export function setCachedUserAgent(ua: string) {
  cachedUserAgent = ua;
}

// P0: Direct cookie injection for testing/mocking scenarios - per-account
export async function injectCookies(email: string, cookies: Array<{name: string, value: string, domain?: string, path?: string}>) {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  const accCtx = accountContexts.get(email);
  if (!accCtx) throw new Error(`No context for account ${email}`);
  await accCtx.context.addCookies(cookies);
  accCtx.lastRefresh = Date.now();
  cachedCookies = null;
  lastCookiesTime = 0;
}

// P0: Direct page access for advanced scenarios (use with caution) - per-account
export function getActivePage(email?: string): Page | null {
  if (email) {
    return accountContexts.get(email)?.page || null;
  }
  // Return first available page if no email specified
  for (const accCtx of accountContexts.values()) {
    return accCtx.page;
  }
  return null;
}

// P0: Direct context access for advanced scenarios - per-account
export function getBrowserContext(email?: string): BrowserContext | null {
  if (!email) return null;
  const ctx = accountContexts.get(email);
  return ctx?.context || null;
}

/**
 * Get the underlying Playwright browser instance.
 * Useful for one-off flows like manual login that need to create temporary contexts.
 */
export function getBrowser(): Browser | null {
  return defaultBrowser || null;
}

export async function loginToQwen(email: string, password: string): Promise<boolean> {
  if (!getActivePage()) throw new Error('Playwright not initialized');

  // Serialize: login mutates shared activePage + global cookie jar
  const release = await uiMutex.acquire();
  try {
  const page = getActivePage()!; // capture post-mutex — another caller could have closed it

  console.log(`[Playwright] Attempting API login for ${email}...`);

  // Navigate to auth page to set up context/cookies
  validateQwenUrl('https://chat.qwen.ai/auth');
  await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  // Qwen expects SHA256 hashed password
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
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, { email, password: hashedPassword });

  if (result.ok) {
    console.log('[Playwright] API login request successful.');
    // Navigate to home to confirm session
    validateQwenUrl('https://chat.qwen.ai/');
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
    const isLogged = !(page.url().includes('auth') || page.url().includes('login'));
    if (isLogged) {
       console.log('[Playwright] Login confirmed.');
       return true;
    }
  }

  console.error('[Playwright] Login failed:', result.data || result.error);
  return false;
  } finally {
    release();
  }
}

async function loginToQwenUI(email: string, password: string): Promise<boolean> {
  const page = getActivePage();
  if (!page) throw new Error('Playwright not initialized');

  // Serialize: UI login mutates shared activePage + global cookie jar
  const release = await uiMutex.acquire();
  try {

  console.log('[Playwright] Attempting UI login...');
  validateQwenUrl('https://chat.qwen.ai/auth');
  await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  if (!page.url().includes('/auth')) {
    console.log('[Playwright] Already logged in');
    return true;
  }

  try {
    await page.waitForSelector('input[type="email"], input[placeholder*="Email"]', { timeout: 5000 });
  } catch {
    if (page.url().includes('/auth')) throw new Error('Email input not found');
    console.log('[Playwright] Already logged in');
    return true;
  }

  console.log('[Playwright] UI: Filling email...');
  await page.fill('input[type="email"], input[placeholder*="Email"]', email);
  await page.keyboard.press('Enter');
  await sleep(1000);

  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  console.log('[Playwright] UI: Filling password...');
  await page.fill('input[type="password"]', password);
  await page.keyboard.press('Enter');

  await sleep(2000);

  const isLogged = !page.url().includes('auth') && !page.url().includes('login');
  if (isLogged) {
    console.log('[Playwright] UI login OK');
    return true;
  }

  console.log('[Playwright] UI login failed');
  return false;
  } finally {
    release();
  }
}

/**
 * Capture bx-headers by making a deliberate API call from the page context.
 * Qwen's frontend JS adds bx-umidtoken and bx-ua to fetch requests automatically.
 * The route handler intercepts these and saves the headers.
 */
async function captureBxHeaders(accCtx: AccountContext): Promise<void> {
  try {
    await accCtx.page.evaluate(async () => {
      await fetch('https://chat.qwen.ai/api/v2/models', {
        method: 'GET',
        headers: { 'accept': 'application/json', 'source': 'web' },
      }).catch(() => {});
    }, { timeout: 10000 } as any);
    await sleep(500);
  } catch (err: any) {
    console.warn(`[AccountContext] bx-header capture fetch failed: ${err.message}`);
  }
}

/**
 * Get headers for a specific account or the best available account.
 * @param email Optional account email - if provided, use that account's context
 */
export type LoginResult = 'success' | 'captcha' | 'closed' | 'error';

export interface BrowserProfileOptions {
  headless?: boolean;
}

export async function openBrowserProfile(email: string, password?: string, options?: BrowserProfileOptions): Promise<LoginResult> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'success' as LoginResult;

  const headless = options?.headless ?? false;
  const profileDir = getProfileDir(email);
  const mode = headless ? 'headless' : 'visible';
  console.log(`[BrowserProfile] Opening persistent profile for ${email} (${mode}) at ${profileDir}`);

  let context: any = null;
  let page: any = null;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 1920, height: 1080 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1920,1080',
        '--window-position=0,0',
      ],
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      (window as any).chrome = { runtime: {} };
      const origQuery = navigator.permissions.query;
      navigator.permissions.query = (params: any) =>
        params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : origQuery.call(navigator.permissions, params);
    });

    const existingCookies: Cookie[] = await context.cookies();
    const existingToken = existingCookies.find((c: Cookie) => c.name === 'token');
    if (existingToken && existingToken.expires && existingToken.expires * 1000 > Date.now()) {
      console.log(`[BrowserProfile] ${email} already has valid token cookie in profile — skipping browser launch`);
      await context.close();
      return 'success';
    }

    page = context.pages()[0] || await context.newPage();

    console.log('[BrowserProfile] Navigating to auth page...');
    validateQwenUrl('https://chat.qwen.ai/auth');
    await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (password) {
      console.log('[BrowserProfile] Filling credentials...');
      try {
        await page.waitForSelector('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]', { timeout: 8000 });
        const emailInput = page.locator('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]').first();
        await emailInput.fill(email);

        await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 5000 });
        const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
        await passwordInput.fill(password);
        console.log('[BrowserProfile] Credentials filled.');

        try {
          const submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")').first();
          await submitBtn.click({ timeout: 3000 });
          console.log('[BrowserProfile] Submit button clicked. Waiting for login...');
        } catch {
          console.log('[BrowserProfile] Could not auto-click submit — user may need to click manually.');
        }
      } catch {
        console.log('[BrowserProfile] Could not find form fields — log in manually.');
      }
    } else {
      console.log('[BrowserProfile] No password provided — user must log in manually.');
    }

    const maxAttempts = headless ? 15 : Infinity;
    console.log(`[BrowserProfile] Polling for login (${headless ? 'headless, max 30s' : 'visible, close browser when done'}).`);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(2000);

      try {
        const cookies: Cookie[] = await context.cookies();
        const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
        if (tokenCookie) {
          console.log('[BrowserProfile] Auth cookie detected!');
          const { saveCookies } = await import('./auth.ts');
          await saveCookies(email, tokenCookie.value);

          console.log('[BrowserProfile] Login complete. Closing browser...');
          try { await context.close(); } catch {}
          return 'success';
        }

        if (attempt > 0 && attempt % 3 === 0) {
          try {
            const hasCaptcha = await page.evaluate(() => {
              return !!(
                document.querySelector('iframe[src*="recaptcha"]') ||
                document.querySelector('iframe[src*="captcha"]') ||
                document.querySelector('[class*="captcha"]') ||
                document.querySelector('[id*="captcha"]') ||
                document.querySelector('.captcha-container') ||
                document.querySelector('[data-sitekey]') ||
                document.querySelector('.g-recaptcha') ||
                Array.from(document.querySelectorAll('iframe')).some(f =>
                  /challenge|verify|captcha|recaptcha/i.test(f.src || '')
                )
              );
            });
            if (hasCaptcha) {
              if (headless) {
                console.log('[BrowserProfile] CAPTCHA detected in headless mode — closing browser, user must solve manually');
                try { await context.close(); } catch {}
                return 'captcha';
              }
              console.log('[BrowserProfile] CAPTCHA/verification challenge detected — keeping browser open for manual solving');
            }
          } catch {
          }
        }
      } catch {
        console.log('[BrowserProfile] Browser closed by user.');
        try { await context.close(); } catch {}
        return 'closed';
      }
    }

    console.log('[BrowserProfile] Headless timeout — no login detected, closing browser');
    try { await context.close(); } catch {}
    return 'error';
  } catch (err: any) {
    console.error('[BrowserProfile] Error:', err.message);
    if (context) { try { await context.close(); } catch {} }
    return 'error';
  }
}

export async function refreshViaProfile(email: string): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true;

  const profileDir = getProfileDir(email);
  console.log(`[BrowserProfile] Refreshing token via persistent profile for ${email}`);

  let context: any = null;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      (window as any).chrome = { runtime: {} };
    });

    const page = context.pages()[0] || await context.newPage();
    validateQwenUrl('https://chat.qwen.ai');
    await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });

    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(1500);
      const cookies: Cookie[] = await context.cookies();
      const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
      if (tokenCookie && tokenCookie.expires && tokenCookie.expires * 1000 > Date.now()) {
        const { saveCookies } = await import('./auth.ts');
        await saveCookies(email, tokenCookie.value);
        console.log(`[BrowserProfile] Token refreshed via profile for ${email}`);
        try { await context.close(); } catch {}
        return true;
      }
    }

    console.log(`[BrowserProfile] No valid token found after profile navigation for ${email}`);
    try { await context.close(); } catch {}
    return false;
  } catch (err: any) {
    console.error(`[BrowserProfile] Profile refresh error for ${email}:`, err.message);
    if (context) { try { await context.close(); } catch {} }
    return false;
  }
}

export async function autoFillLogin(email: string, password: string): Promise<boolean> {
  const result = await openBrowserProfile(email, password);
  return result === 'success';
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
  
  // Determine which account to use
  const targetEmail = email || pickAccount()?.email;
  if (!targetEmail) {
    throw new Error('No account available for header extraction');
  }

  // Get or create the account context
  let accCtx = accountContexts.get(targetEmail);
  if (!accCtx) {
    // Try to get initial cookies from auth service
    const tokenInfo = getTokenWithAccount(targetEmail);
    const initialCookies = tokenInfo?.token ? { token: tokenInfo.token } : undefined;
    accCtx = await createAccountContext(targetEmail, initialCookies);
    // Navigate to establish cookies and trigger request interceptors
    await refreshAccountCookies(targetEmail);
    // Explicitly capture bx-headers by making a fetch from the page context
    await captureBxHeaders(accCtx);
    accCtx = accountContexts.get(targetEmail)!;
  } else if (Date.now() - accCtx.lastRefresh > COOKIE_REFRESH_INTERVAL) {
    // Refresh if stale (>30s)
    await refreshAccountCookies(targetEmail);
    accCtx = accountContexts.get(targetEmail)!;
  }

  // Extract current headers from the account's context
  const cookies = await accCtx.context.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  const headers: Record<string, string> = {
    ...accCtx.headers,
    'cookie': cookieStr
  };
  
  // Update cached headers for this account
  accCtx.headers = headers;
  accCtx.lastRefresh = Date.now();

  // Generate new chat session
  const chatSessionId = crypto.randomUUID();
  
  return {
    headers,
    chatSessionId,
    parentMessageId: null
  };
}
