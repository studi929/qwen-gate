/*
 * File: loginHelpers.ts
 * Login implementation helpers extracted from auth.ts.
 * Contains the three login strategies: browser context, fetch, and temp context.
 */

import crypto from 'crypto';
import { getActivePage, getBrowser, createAccountContext } from './playwright.ts';
import { AUTH_TOKEN_MAX_AGE_MS, createAuthFetchTimeout, checkPlaywrightSession, type AuthState } from "./auth.ts";

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

export class LoginMutex {
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
 * Login via browser context — executes signin API inside the browser via evaluate().
 */
export async function loginFreshViaBrowser(
  email: string,
  hashedPassword: string,
  loginMutex: LoginMutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const page = getActivePage();
    if (!page) return null;

    try {
      const currentUrl = page.url();
      if (!currentUrl.startsWith(QWEN_CHAT_URL)) {
        await page.goto(QWEN_CHAT_URL, { waitUntil: 'domcontentloaded' });
      }
    } catch (err: any) {
      console.warn(`[Auth] Navigation check failed for ${email}: ${err.message}`);
    }

    try {
      const context = page.context();
      const existingCookies = await context.cookies();
      const authCookies = existingCookies.filter(c =>
        c.name === 'token' ||
        c.name === 'refresh_token'
      );
      if (authCookies.length > 0) {
        // Only remove specific auth cookies, not ALL cookies
        for (const c of authCookies) {
          await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
        }
      }
    } catch (err: any) {
      console.warn(`[Auth] Cookie clearing failed for ${email}: ${err.message}`);
    }

    let evalResult: { ok: boolean; status: number; token: string | null; refreshToken: string | null; dataKeys: string[] };
    try {
      evalResult = await page.evaluate(async ({ email, hashedPassword }: { email: string; hashedPassword: string }) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15_000);
        let response: Response;
        try {
          response = await fetch(`${QWEN_CHAT_URL}/api/v2/auths/signin`, {
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
        try { data = await response.json(); } catch {
          // non-blocking: non-JSON responses fall back to empty data
        }

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

    const finalToken = evalResult.token || cookieToken;
    const finalRefresh = evalResult.refreshToken || cookieRefresh;

    if (finalToken) {
      return {
        token: finalToken,
        expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
        refreshToken: finalRefresh,
      };
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
 * Login via plain fetch — fallback for when Playwright is not available.
 */
export async function loginFreshViaFetch(email: string, hashedPassword: string): Promise<AuthState | null> {
  const { controller, cleanup: _cleanup } = createAuthFetchTimeout();
  try {
    const response = await fetch(`${QWEN_CHAT_URL}/api/v2/auths/signin`, {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
        'Version': '0.2.57',
        'bx-v': '2.5.36',
        'Referer': `${QWEN_CHAT_URL}/auth`,
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
        return {
          token,
          expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
          refreshToken,
        };
      }

      const hasPlaywrightSession = await checkPlaywrightSession();
      if (hasPlaywrightSession) {
        console.warn(`[Auth] API login returned 200 but no token for ${email}, and Playwright session exists but has no usable token`);
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

export async function loginViaTempContext(
  _browser: ReturnType<typeof getBrowser>,
  email: string,
  hashedPassword: string,
  loginMutex: LoginMutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const accCtx = await createAccountContext(email);
    const page = accCtx.page;
    const context = accCtx.context;

    let capturedToken: string | null = null;
    let capturedRefresh: string | null = null;

    // Intercept signin API to capture token from BOTH JSON body AND set-cookie headers
    await page.route('**/api/v2/auths/signin', async (route) => {
      try {
        const response = await route.fetch();

        // Try to extract token from JSON response body first (fastest path)
        try {
          const body = await response.json();
          const jsonToken = body?.data?.token || body?.token || body?.data?.session_token || null;
          const jsonRefresh = body?.data?.refresh_token || body?.refresh_token || null;
          if (jsonToken && !capturedToken) capturedToken = jsonToken;
          if (jsonRefresh && !capturedRefresh) capturedRefresh = jsonRefresh;
        } catch {
          // non-JSON response, fall through to cookie extraction
        }

        // Also check set-cookie headers as fallback
        const setCookies = response.headersArray()
          .filter(h => h.name.toLowerCase() === 'set-cookie')
          .map(h => h.value);
        for (const cookie of setCookies) {
          const tokenMatch = cookie.match(/\btoken=([^;]+)/);
          if (tokenMatch && !capturedToken) capturedToken = tokenMatch[1];
          const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
          if (refreshMatch && !capturedRefresh) capturedRefresh = refreshMatch[1];
        }

        await route.fulfill({ response });
      } catch (err: any) {
        // If route.fetch fails, let the request pass through normally
        await route.continue();
      }
    });

    try {
      await page.goto(`${QWEN_CHAT_URL}/auth`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      // non-blocking
    }

    try {
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10_000 });
      await page.fill('input[type="email"], input[name="email"]', email);
      await page.fill('input[type="password"], input[name="password"]', hashedPassword);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")'),
        page.waitForURL(url => !url.toString().includes('/auth'), { timeout: 15_000 }).catch(() => {}),
      ]);
    } catch {
      // non-blocking
    }

    // Poll for token with shorter intervals instead of blind sleep
    for (let attempt = 0; attempt < 10; attempt++) {
      if (capturedToken) break;
      await new Promise(r => setTimeout(r, 500));

      // Check cookies as fallback
      try {
        const cookies = await context.cookies();
        const tokenCookie = cookies.find(c =>
          c.name === 'token' ||
          (c.name.toLowerCase().includes('token') && c.domain.includes('qwen') && !c.name.toLowerCase().includes('refresh'))
        );
        const refreshCookie = cookies.find(c =>
          c.name === 'refresh_token' ||
          (c.name.toLowerCase().includes('refresh') && c.domain.includes('qwen'))
        );
        if (tokenCookie?.value) capturedToken = tokenCookie.value;
        if (refreshCookie?.value) capturedRefresh = refreshCookie.value;
      } catch {
        // non-blocking
      }
    }

    await page.unroute('**/api/v2/auths/signin');

    if (capturedToken) {
      return {
        token: capturedToken,
        expiresAt: Date.now() + AUTH_TOKEN_MAX_AGE_MS,
        refreshToken: capturedRefresh,
      };
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
