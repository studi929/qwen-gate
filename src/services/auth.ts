/*
 * File: auth.ts
 * Core authentication: login, cookies, token management.
 * Account management is in accountManager.ts. Token refresh is in tokenRefresh.ts.
 * Login helpers are in loginHelpers.ts.
 */

import crypto from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getActivePage, getBrowser } from './playwright.ts';
import { logStore } from './logStore.js';
import {
  decodeJwt,
  discoverSavedAccounts,
  loadAccountsFromFile, setupAccountWatcher as setupAccountWatcherImpl,
  enableHotReload as enableHotReloadImpl, resetWatcherState,
  migrateFromOldPaths,
  rebuildEmailIndex,
} from './accountManager.ts';
import { needsRefresh, ensureAccountFresh } from './tokenRefresh.ts';
import { LoginMutex, loginFreshViaBrowser, loginFreshViaFetch, loginViaTempContext } from './loginHelpers.ts';
import { config } from './configService.ts';

export { tryRefreshToken, ensureAccountFresh, needsRefresh } from './tokenRefresh.ts';
export {
  addAccount, removeAccount, reloadAccounts, discoverSavedAccounts,
  decodeJwt,
  isAvailable, pickAccount, incrementInFlight, decrementInFlight,
  incrementTotalRequests, hasInFlight, getAccountByEmail,
  getToken, getTokenWithAccount, throttleAccount, isAccountThrottled,
  getAccountStats, getAccountCount, getAvailableCount, getAllAccountEmails, getAccounts,
} from './accountManager.ts';

export const AUTH_TOKEN_MAX_AGE_MS = parseInt(config.get('AUTH_TOKEN_MAX_AGE_MS', '28800000'), 10);
export const AUTH_REFRESH_BEFORE_MS = parseInt(config.get('AUTH_REFRESH_BEFORE_MS', '300000'), 10);
const TOKEN_DIR = join(process.cwd(), '.qwen', 'tokens');

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

  // Try fetch first — it's the fastest (no browser overhead)
  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    const fetchResult = await loginFreshViaFetch(email, hashedPassword);
    if (fetchResult) {
      logStore.log('info', 'auth', 'Login success (fetch): ' + email);
      return fetchResult;
    }
  }

  // Fallback to browser strategies if fetch fails
  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    const activePage = getActivePage();
    if (activePage) {
      const browserResult = await loginFreshViaBrowser(email, hashedPassword, loginMutex);
      if (browserResult) {
        logStore.log('info', 'auth', 'Login success: ' + email);
        return browserResult;
      }
      logStore.log('warn', 'auth', `Browser login failed for ${email}, trying temp context...`);
    }

    const browser = getBrowser();
    if (browser) {
      const tempResult = await loginViaTempContext(browser, email, hashedPassword, loginMutex);
      if (tempResult) {
        logStore.log('info', 'auth', 'Login success (temp context): ' + email);
        return tempResult;
      }
      logStore.log('warn', 'auth', `Temp context login failed for ${email}`);
    }
  }

  logStore.log('error', 'auth', 'Login failed: ' + email);
  return null;
}

export async function initAuth(onAccountReady?: (email: string) => Promise<void>): Promise<void> {
  if (initDone) return;

  migrateFromOldPaths();

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
    initDone = true;
    logStore.log('warn', 'auth', 'No saved accounts found. Run: npm run login user@example.com');
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
  rebuildEmailIndex();

  try {
    // Phase 1: Load tokens from browser profiles — max 3 concurrent Chromium instances
    const MAX_CONCURRENT_PROFILE_LOADS = 3;
    const loadResults: Array<{ acct: typeof accounts[0]; source: string | null }> = [];
    
    for (let i = 0; i < accounts.length; i += MAX_CONCURRENT_PROFILE_LOADS) {
      const batch = accounts.slice(i, i + MAX_CONCURRENT_PROFILE_LOADS);
      const batchResults = await Promise.allSettled(
        batch.map(async (acct) => {
          const profileState = await loadCookiesFromProfile(acct.email);
          if (profileState) {
            acct.state = profileState;
            return { acct, source: 'profile' as const };
          }
          return { acct, source: null as string | null };
        })
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled') loadResults.push(r.value);
      }
    }

    // Phase 2: Login accounts that don't have tokens yet — max 3 concurrent
    const needLogin = accounts.filter(a => !a.state?.token && a.password);
    if (needLogin.length > 0) {
      logStore.log('info', 'auth', `Logging in ${needLogin.length} accounts (max ${MAX_CONCURRENT_PROFILE_LOADS} concurrent)...`);
      for (let i = 0; i < needLogin.length; i += MAX_CONCURRENT_PROFILE_LOADS) {
        const batch = needLogin.slice(i, i + MAX_CONCURRENT_PROFILE_LOADS);
        await Promise.allSettled(
          batch.map(async (acct) => {
            const newState = await loginFresh(acct.email, acct.password);
            if (newState) {
              acct.state = newState;
              await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
            }
          })
        );
      }
    }

    // Phase 3: Run post-login callbacks in parallel
    if (onAccountReady) {
      const readyPromises = accounts
        .filter(a => a.state?.token)
        .map(async (acct) => {
          try {
            await onAccountReady(acct.email);
          } catch (err: any) {
            logStore.log('warn', 'auth', `Post-login config failed for ${acct.email}: ${err.message}`);
          }
        });
      await Promise.allSettled(readyPromises);
    }

    const successCount = accounts.filter(a => a.state !== null && a.state.token).length;
    logStore.log('info', 'auth', successCount + '/' + accounts.length + ' accounts authenticated');

    setupAccountWatcherImpl();

    initDone = true;
  } catch (err) {
    initDone = false;
    throw err;
  }
}

export async function autoLoginAllAccounts(): Promise<void> {
  const needLogin = accounts.filter(a => !a.state && a.password);
  if (needLogin.length === 0) return;

  const loginPromises = needLogin.map(async (acct) => {
    const newState = await loginFresh(acct.email, acct.password);
    if (newState) {
      acct.state = newState;
      await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
    }
  });
  await Promise.allSettled(loginPromises);
}

export async function ensureAllFresh(): Promise<void> {
  const stale = accounts.filter(a => a.state && needsRefresh(a));
  if (stale.length === 0) return;
  await Promise.allSettled(stale.map(a => ensureAccountFresh(a)));
}

export async function loadCookiesFromProfile(email: string): Promise<AuthState | null> {
  try {
    const { getProfileDir } = await import('./playwright.ts');
    const profileDir = getProfileDir(email);
    if (!existsSync(profileDir)) {
      logStore.log('warn', 'auth', `No profile dir for ${email}`);
      return null;
    }

    // Look up password from accounts array
    const acct = accounts.find(a => a.email.toLowerCase().trim() === email.toLowerCase().trim());
    const password = acct?.password;

    logStore.log('info', 'auth', `Loading token from profile for ${email}...`);
    const { launchPersistentContext } = await import('cloakbrowser');
    const context = await launchPersistentContext({
      userDataDir: profileDir,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--no-first-run', '--disable-background-networking', '--disable-default-apps', '--disable-sync', '--disable-translate', '--disable-blink-features=AutomationControlled'],
    });

    try {
      let cookies = await context.cookies();
      let authCookie = cookies.find(c => {
        const n = c.name.toLowerCase();
        if (n.includes('refresh')) return false;
        return n.includes('token') || n.includes('session');
      });

      // No auth cookie — authorize the profile via openBrowserProfile
      if (!authCookie?.value && password) {
        logStore.log('info', 'auth', `Authorizing profile for ${email}...`);
        try { await context.close(); } catch { /* non-blocking */ }
        
        const { openBrowserProfile } = await import('./browserProfiles.ts');
        const result = await openBrowserProfile(email, password, { headless: true });
        
        if (result === 'success') {
          const updated = accounts.find(a => a.email.toLowerCase().trim() === email.toLowerCase().trim());
          if (updated?.state) {
            logStore.log('info', 'auth', `✓ Authorized ${email} via browser profile`);
            return updated.state;
          }
          logStore.log('warn', 'auth', `Profile auth succeeded but no state for ${email}, letting caller retry`);
          return null;
        } else {
          logStore.log('warn', 'auth', `Profile authorization failed for ${email}: ${result}`);
          return null;
        }
      }

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
          logStore.log('info', 'auth', `✓ Token loaded from profile for ${email}`);
          return state;
        } else {
          logStore.log('warn', 'auth', `Token expired for ${email}`);
        }
      } else if (!authCookie?.value && password) {
        logStore.log('warn', 'auth', `No auth cookie found in profile for ${email}`);
      }
    } finally {
      try { await context.close(); } catch { /* non-blocking */ }
    }
  } catch (err: any) {
    if (err?.message?.toLowerCase().includes('lock')) {
      logStore.log('warn', 'auth', `Profile lock error for ${email}`);
      return null;
    }
    logStore.log('warn', 'auth', `Profile cookie load failed for ${email}: ${err.message}`);
  }
  return null;
}

export async function saveCookies(email: string, token: string, refreshToken?: string | null, expiresAt?: number): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  try {
    let jwtExpiresAt = expiresAt;
    if (!jwtExpiresAt) {
      const payload = decodeJwt(token);
      if (payload?.exp && typeof payload.exp === 'number') {
        jwtExpiresAt = payload.exp * 1000;
      } else {
        jwtExpiresAt = Date.now() + AUTH_TOKEN_MAX_AGE_MS;
      }
    }

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

      // Fire-and-forget disk persistence
      try {
        mkdirSync(TOKEN_DIR, { recursive: true });
        writeFileSync(
          join(TOKEN_DIR, `${normalizedEmail}.json`),
          JSON.stringify({ token, refreshToken, expiresAt: jwtExpiresAt }),
          'utf-8'
        );
      } catch { /* non-blocking */ }
    }
  } catch (err: any) {
    logStore.log('error', 'auth', `Failed to save cookies for ${normalizedEmail}: ${err.message}`);
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
