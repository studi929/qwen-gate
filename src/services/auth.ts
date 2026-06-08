/*
 * File: auth.ts
 * Core authentication: login, cookies, token management.
 * Account management is in accountManager.ts. Token refresh is in tokenRefresh.ts.
 * Login helpers are in loginHelpers.ts.
 */

import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { getActivePage, getBrowser } from './playwright.ts';
import { logStore } from './logStore.js';
import {
  COOKIE_DIR, getCookieFilePath, decodeJwt, discoverSavedAccounts,
  loadAccountsFromFile, setupAccountWatcher as setupAccountWatcherImpl,
  enableHotReload as enableHotReloadImpl, resetWatcherState,
  encrypt, decrypt,
} from './accountManager.ts';
import { needsRefresh, ensureAccountFresh } from './tokenRefresh.ts';
import { LoginMutex, loginFreshViaBrowser, loginFreshViaFetch, loginViaTempContext } from './loginHelpers.ts';
import { config } from './configService.ts';

export { tryRefreshToken, ensureAccountFresh, needsRefresh } from './tokenRefresh.ts';
export {
  addAccount, removeAccount, reloadAccounts, discoverSavedAccounts,
  COOKIE_DIR, getCookieFilePath, decodeJwt,
  isAvailable, pickAccount, incrementInFlight, decrementInFlight,
  incrementTotalRequests, hasInFlight, getAccountByEmail,
  getToken, getTokenWithAccount, throttleAccount, isAccountThrottled,
  getAccountStats, getAccountCount, getAvailableCount, getAllAccountEmails, getAccounts,
} from './accountManager.ts';
export type { CookieData } from './accountManager.ts';

export const AUTH_TOKEN_MAX_AGE_MS = parseInt(config.get('AUTH_TOKEN_MAX_AGE_MS', '28800000'), 10);
export const AUTH_REFRESH_BEFORE_MS = parseInt(config.get('AUTH_REFRESH_BEFORE_MS', '300000'), 10);

const AUTH_FETCH_TIMEOUT_MS = parseInt(config.get('QWEN_FETCH_TIMEOUT_MS', '30000'), 10);

export function createAuthFetchTimeout(): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);
  return {
    controller,
    cleanup: () => clearTimeout(timeout),
  };
}

export async function checkPlaywrightSession(): Promise<boolean> {
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
  inFlight: number;
  totalRequests: number;
}

export const accounts: AccountEntry[] = [];
let initDone = false;

const loginMutex = new LoginMutex();

export async function loginFresh(email: string, password: string): Promise<AuthState | null> {
  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    const activePage = getActivePage();
    if (activePage) {
      const browserResult = await loginFreshViaBrowser(email, hashedPassword, loginMutex);
      if (browserResult) {
        logStore.log('info', 'auth', 'Login success: ' + email);
        return browserResult;
      }
      console.warn(`[Auth] Browser login failed for ${email}, trying temp context...`);
    }

    const browser = getBrowser();
    if (browser) {
      const tempResult = await loginViaTempContext(browser, email, password, loginMutex);
      if (tempResult) {
        logStore.log('info', 'auth', 'Login success (temp context): ' + email);
        return tempResult;
      }
      console.warn(`[Auth] Temp context login failed for ${email}, trying fetch fallback...`);
    }
  }

  const fetchResult = await loginFreshViaFetch(email, hashedPassword);
  if (fetchResult) {
    logStore.log('info', 'auth', 'Login success (fetch): ' + email);
  } else {
    logStore.log('error', 'auth', 'Login failed: ' + email);
  }
  return fetchResult;
}

export async function initAuth(onAccountReady?: (email: string) => Promise<void>): Promise<void> {
  if (initDone) return;
  initDone = true;

  const persisted = loadAccountsFromFile();
  const discovered = discoverSavedAccounts();

  const merged = [...discovered];
  for (const p of persisted) {
    const existing = merged.find(a => a.email.toLowerCase().trim() === p.email.toLowerCase().trim());
    if (existing) {
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

  accounts.length = 0;
  for (const a of merged) {
    accounts.push({
      email: a.email,
      password: a.password,
      state: null,
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
    });
  }

  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];

    const savedState = await loadSavedCookies(acct.email);
    if (savedState) {
      acct.state = savedState;
    } else {
      const profileState = await loadCookiesFromProfile(acct.email);
      if (profileState) {
        acct.state = profileState;
      } else if (acct.password) {
        const newState = await loginFresh(acct.email, acct.password);
        if (newState) {
          acct.state = newState;
          await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
        }
      }
    }

    if (acct.state?.token && onAccountReady) {
      try {
        await onAccountReady(acct.email);
      } catch (err: any) {
        logStore.log('warn', 'auth', `Post-login config failed for ${acct.email}: ${err.message}`);
      }
    }

    if (i < accounts.length - 1) {
      await new Promise(r => setTimeout(r, acct.password && !acct.state ? 2000 : 1000));
    }
  }

  const successCount = accounts.filter(a => a.state !== null && a.state.token).length;
  logStore.log('info', 'auth', successCount + '/' + accounts.length + ' accounts authenticated');

  setupAccountWatcherImpl();
}

export async function autoLoginAllAccounts(): Promise<void> {
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    if (acct.state || !acct.password) continue;
    const newState = await loginFresh(acct.email, acct.password);
    if (newState) {
      acct.state = newState;
      await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
    }
    if (i < accounts.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

export async function ensureAllFresh(): Promise<void> {
  const stale = accounts.filter(a => a.state && needsRefresh(a));
  if (stale.length === 0) return;
  await Promise.allSettled(stale.map(a => ensureAccountFresh(a)));
}

export async function loadSavedCookies(email: string): Promise<AuthState | null> {
  try {
    const filePath = getCookieFilePath(email);
    if (!existsSync(filePath)) {
      // Constant-time delay to prevent account enumeration via timing
      await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
      return null;
    }

    const raw = readFileSync(filePath, 'utf-8');
    const apiKey = config.get("API_KEY");
    let jsonStr = raw;
    // Try to decrypt; fallback to raw for legacy unencrypted files
    if (apiKey) {
      try {
        jsonStr = decrypt(raw, apiKey);
      } catch {
        // File is likely unencrypted (legacy format) — use raw
      }
    }
    const data = JSON.parse(jsonStr) as { email: string; token: string; refreshToken: string | null; expiresAt: number };

    if (!data.token || data.email.toLowerCase() !== email.toLowerCase()) return null;

    const payload = decodeJwt(data.token);
    if (payload?.exp && payload.exp * 1000 < Date.now()) {
      return null;
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

export async function loadCookiesFromProfile(email: string): Promise<AuthState | null> {
  try {
    const { getProfileDir } = await import('./playwright.ts');
    const profileDir = getProfileDir(email);
    if (!existsSync(profileDir)) return null;

    const { launchPersistentContext } = await import('cloakbrowser');
    const context = await launchPersistentContext({
      userDataDir: profileDir,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
    });

    try {
      let cookies = await context.cookies();
      const hasAuth = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));

      if (!hasAuth) {
        // Navigate to Qwen to trigger cookie refresh from profile storage
        const page = context.pages()[0] || await context.newPage();
        await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));
        cookies = await context.cookies();
      }

      const authCookie = cookies.find(c =>
        c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session')
      );

      if (authCookie?.value) {
        const payload = decodeJwt(authCookie.value);
        const expiresAt = payload?.exp ? payload.exp * 1000 : Date.now() + AUTH_TOKEN_MAX_AGE_MS;
        if (expiresAt > Date.now()) {
          const refreshCookie = cookies.find(c => c.name.toLowerCase().includes('refresh'));
          const state: AuthState = {
            token: authCookie.value,
            expiresAt,
            refreshToken: refreshCookie?.value || null,
          };
          await saveCookies(email, state.token, state.refreshToken, state.expiresAt);
          return state;
        }
      }
    } finally {
      try { await context.close(); } catch { /* non-blocking */ }
    }
  } catch (err: any) {
    console.warn(`[Auth] Profile cookie load failed for ${email}: ${err.message}`);
  }
  return null;
}

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

    const data = {
      email: normalizedEmail,
      token,
      refreshToken: refreshToken || null,
      savedAt: Date.now(),
      expiresAt: jwtExpiresAt,
    };

    const jsonStr = JSON.stringify(data, null, 2);
    const apiKey = config.get("API_KEY");
    const output = apiKey ? encrypt(jsonStr, apiKey) : jsonStr;
    writeFileSync(getCookieFilePath(normalizedEmail), output, 'utf-8');

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

export function setupAccountWatcher(): void {
  setupAccountWatcherImpl();
}

export function enableHotReload(): void {
  enableHotReloadImpl();
}

export function clearAuth(): void {
  accounts.length = 0;
  initDone = false;
  resetWatcherState();
}

export async function ensureAuthenticated(): Promise<boolean> {
  if (accounts.length === 0) {
    await initAuth();
  }
  await ensureAllFresh();
  return accounts.some(a => a.state !== null);
}
