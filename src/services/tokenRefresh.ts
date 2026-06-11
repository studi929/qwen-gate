/*
 * File: tokenRefresh.ts
 * Token refresh logic extracted from auth.ts.
 * Handles refresh token exchange and ensuring accounts stay fresh.
 */

import { createAuthFetchTimeout, AUTH_TOKEN_MAX_AGE_MS, AUTH_REFRESH_BEFORE_MS, saveCookies, loginFresh, type AccountEntry } from "./auth.ts";
import { logStore } from './logStore.ts';

export function needsRefresh(acct: AccountEntry): boolean {
  if (!acct.state) return true;
  return acct.state.expiresAt - AUTH_REFRESH_BEFORE_MS < Date.now();
}

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

export async function tryRefreshToken(acct: AccountEntry): Promise<boolean> {
  if (!acct.state?.refreshToken) return false;

  const { controller, cleanup } = createAuthFetchTimeout();
  try {
    const response = await fetch(`${QWEN_CHAT_URL}/api/v2/auths/refresh`, {
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
          // non-blocking: throttle already cleared or not set
        }
        return true;
      }
    }

    logStore.log('error', 'auth', `HTTP refresh failed for ${acct.email} — falling back to profile-based refresh`);
    try {
      const { refreshViaProfile } = await import('./playwright.ts');
      const profileResult = await refreshViaProfile(acct.email);
      if (profileResult) {
        return true;
      }
    } catch (profileErr: any) {
      logStore.log('error', 'auth', `Profile refresh fallback failed for ${acct.email}: ${profileErr.message}`);
    }

    return false;
  } catch (err: any) {
    logStore.log('error', 'auth', 'HTTP fetch failed:', err);
    try {
      const { refreshViaProfile } = await import('./playwright.ts');
      const profileResult = await refreshViaProfile(acct.email);
      if (profileResult) {
        logStore.log('error', 'auth', `✓ Token refreshed via profile for ${acct.email} (after network error)`);
        return true;
      }
    } catch (innerErr: any) {
      logStore.log('error', 'auth', `Profile refresh fallback failed: ${innerErr}`);
      // non-blocking: profile refresh may fail if browser unavailable
    }
    return false;
  } finally {
    cleanup();
  }
}

export async function ensureAccountFresh(acct: AccountEntry): Promise<boolean> {
  if (acct.state && !needsRefresh(acct)) return true;

  // Avoid concurrent refresh for same account
  if (acct.refreshInFlight) {
    return acct.refreshInFlight;
  }

  acct.refreshInFlight = (async () => {
    try {
      if (acct.state?.refreshToken) {
        if (await tryRefreshToken(acct)) return true;
        logStore.log('warn', 'auth', `Refresh token failed for ${acct.email}`);
      }

      if (acct.throttledUntil > Date.now()) {
        const waitSec = Math.ceil((acct.throttledUntil - Date.now()) / 1000);
        logStore.log('warn', 'auth', `Skipping re-login for ${acct.email} — throttled for ${waitSec}s more`);
        return false;
      }

      const newState = await loginFresh(acct.email, acct.password);
      if (newState) {
        acct.state = newState;
        await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
        return true;
      }
      return false;
    } finally {
      acct.refreshInFlight = null;
    }
  })();

  return acct.refreshInFlight;
}
