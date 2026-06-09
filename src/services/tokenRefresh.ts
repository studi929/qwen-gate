/*
 * File: tokenRefresh.ts
 * Token refresh logic extracted from auth.ts.
 * Handles refresh token exchange and ensuring accounts stay fresh.
 */

import { createAuthFetchTimeout, AUTH_TOKEN_MAX_AGE_MS, AUTH_REFRESH_BEFORE_MS, saveCookies, loginFresh, type AccountEntry } from "./auth.ts";

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
        const newToken = data.data.token;
        const newRefresh = data.data.refresh_token || acct.state.refreshToken;
        const payload = (await import('./auth.ts')).decodeJwt(newToken);
        const newExpiresAt = payload?.exp ? payload.exp * 1000 : Date.now() + AUTH_TOKEN_MAX_AGE_MS;
        acct.state = {
          token: newToken,
          expiresAt: newExpiresAt,
          refreshToken: newRefresh,
        };
        await saveCookies(acct.email, newToken, newRefresh, newExpiresAt);
        if (acct.throttledUntil > Date.now()) {
          acct.throttledUntil = 0;
        } else {
          // non-blocking: throttle already cleared or not set
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
  } catch (err: any) {
    console.error('[TokenRefresh] HTTP fetch failed:', err);
    try {
      const { refreshViaProfile } = await import('./playwright.ts');
      const profileResult = await refreshViaProfile(acct.email);
      if (profileResult) {
        console.error(`[Auth] ✓ Token refreshed via profile for ${acct.email} (after network error)`);
        return true;
      }
    } catch (innerErr: any) {
      console.error('[TokenRefresh] Profile refresh fallback failed:', innerErr);
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
