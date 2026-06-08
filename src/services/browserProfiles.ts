/*
 * File: browserProfiles.ts
 * Browser profile management extracted from playwright.ts.
 * Handles persistent browser profiles, auto-fill login, and token refresh via profiles.
 */

import { launchPersistentContext as cloakPersistentContext } from 'cloakbrowser';
import { mkdirSync } from 'fs';
import type { Cookie } from 'playwright';
import { projectPath } from '../utils/paths.ts';

export function getProfileDir(email: string): string {
  const safe = email.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  const dir = projectPath('qwen_profile', 'chromium-profiles', safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type LoginResult = 'success' | 'captcha' | 'closed' | 'error';

export interface BrowserProfileOptions {
  headless?: boolean;
}

import { validateQwenUrl } from './playwright.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getBrowserArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--window-size=1920,1080',
    '--window-position=0,0',
    '--disable-dev-shm-usage',
    '--disable-popup-blocking',
    '--mute-audio',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--disable-blink-features=AutomationControlled',
  ];
}

async function setupBrowserContext(email: string, headless: boolean): Promise<any> {
  const profileDir = getProfileDir(email);
  return await cloakPersistentContext({
    userDataDir: profileDir,
    headless,
    humanize: true,
    geoip: true,
    viewport: { width: 1920, height: 1080 },
    args: getBrowserArgs(),
  });
}

async function checkExistingToken(context: any): Promise<boolean> {
  const existingCookies: Cookie[] = await context.cookies();
  const existingToken = existingCookies.find((c: Cookie) => c.name === 'token');
  return !!(existingToken && existingToken.expires && existingToken.expires * 1000 > Date.now());
}

async function fillLoginForm(page: any, email: string, password: string): Promise<void> {
  try {
    await page.waitForSelector('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]', { timeout: 8000 });
    const emailInput = page.locator('input[type="email"], input[placeholder*="Email"], input[name="email"], input[name="login"]').first();
    await emailInput.click();
    await sleep(300 + Math.random() * 400);
    await emailInput.pressSequentially(email, { delay: 50 + Math.random() * 80 });

    await sleep(200 + Math.random() * 300);
    await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 5000 });
    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    await passwordInput.click();
    await sleep(200 + Math.random() * 300);
    await passwordInput.pressSequentially(password, { delay: 40 + Math.random() * 60 });

    await sleep(500 + Math.random() * 500);
    try {
      const submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")').first();
      await submitBtn.click({ timeout: 3000 });
    } catch {
      // non-blocking: submit button may not exist on some login pages
    }
  } catch {
    // non-blocking: form fill may fail if selector not found
  }
}

async function detectCaptcha(page: any): Promise<boolean> {
  return await page.evaluate(() => {
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
}

async function tryCheckToken(context: any, email: string): Promise<LoginResult | null> {
  try {
    const cookies: Cookie[] = await context.cookies();
    const tokenCookie = cookies.find((c: Cookie) => c.name === 'token');
    if (!tokenCookie) return null;
    const { saveCookies } = await import('./auth.ts');
    await saveCookies(email, tokenCookie.value);
    try { await context.close(); } catch { /* non-blocking */ }
    return 'success';
  } catch {
    try { await context.close(); } catch { /* non-blocking */ }
    return 'closed';
  }
}

async function tryCheckCaptcha(page: any, context: any, attempt: number, headless: boolean): Promise<'captcha' | null> {
  if (attempt <= 0 || attempt % 3 !== 0) return null;
  try {
    const hasCaptcha = await detectCaptcha(page);
    if (!hasCaptcha) return null;
    if (headless) {
      try { await context.close(); } catch { /* non-blocking */ }
      return 'captcha';
    }
  } catch { /* captcha detection failure is non-blocking */ }
  return null;
}

async function pollForToken(page: any, context: any, email: string, headless: boolean): Promise<LoginResult | null> {
  const maxAttempts = headless ? 15 : Infinity;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(2000);

    const tokenResult = await tryCheckToken(context, email);
    if (tokenResult) return tokenResult;

    const captchaResult = await tryCheckCaptcha(page, context, attempt, headless);
    if (captchaResult) return captchaResult;
  }
  return null;
}

export async function openBrowserProfile(email: string, password?: string, options?: BrowserProfileOptions): Promise<LoginResult> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'success' as LoginResult;

  const headless = options?.headless ?? false;
  let context: any = null;
  let page: any = null;

  try {
    context = await setupBrowserContext(email, headless);
    if (await checkExistingToken(context)) {
      await context.close();
      return 'success';
    }

    page = context.pages()[0] || await context.newPage();

    validateQwenUrl('https://chat.qwen.ai/auth');
    await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (password) {
      await fillLoginForm(page, email, password);
    }

    const result = await pollForToken(page, context, email, headless);
    if (result) return result;

    console.error('[BrowserProfile] Headless timeout — no login detected, closing browser');
    try { await context.close(); } catch {
      // non-blocking
    }
    return 'error';
  } catch (err: any) {
    console.error('[BrowserProfile] Error:', err.message);
    if (context) { try { await context.close(); } catch {
      // non-blocking
    } }
    return 'error';
  }
}

export async function refreshViaProfile(email: string): Promise<boolean> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return true;

  const profileDir = getProfileDir(email);
  let context: any = null;

  try {
    context = await cloakPersistentContext({
      userDataDir: profileDir,
      headless: true,
      humanize: true,
      geoip: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-popup-blocking',
        '--mute-audio',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--disable-blink-features=AutomationControlled',
      ],
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
        try { await context.close(); } catch {
          // intentional
        }
        return true;
      }
    }

    console.error(`[BrowserProfile] No valid token found after profile navigation for ${email}`);
    try { await context.close(); } catch {
      // intentional
    }
    return false;
  } catch (err: any) {
    console.error(`[BrowserProfile] Profile refresh error for ${email}:`, err.message);
    if (context) { try { await context.close(); } catch {
      // intentional
    } }
    return false;
  }
}

export async function autoFillLogin(email: string, password: string): Promise<boolean> {
  const result = await openBrowserProfile(email, password);
  return result === 'success';
}
