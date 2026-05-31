import { launchPersistentContext } from 'cloakbrowser';
import { closePlaywright, getProfileDir } from "./services/playwright.ts";
import { saveCookies } from './services/auth.ts';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Authenticate a user account via browser login flow.
 * @param email - User email address for session labeling
 * @returns Promise that resolves when session is saved
 */
export async function login(email: string): Promise<void> {
  
  // Use persistent context so browser UI state (cookies, localStorage) survives across runs
  const profileDir = getProfileDir(email);
  
  const context = await launchPersistentContext({
    userDataDir: profileDir,
    viewport: { width: 1280, height: 800 },
    headless: false,
  });
  const page = await context.newPage();

  await page.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
  });

  const cookies = await context.cookies();
  const tokenCookie = cookies.find(c => c.name === 'token');
  const refreshCookie = cookies.find(c => c.name === 'refresh_token');

  if (!tokenCookie?.value) {
    console.error('No token cookie found. Login may have failed.');
    await closePlaywright();
    process.exit(1);
  }

  await saveCookies(email, tokenCookie.value, refreshCookie?.value || null);
  // Close persistent context (browser exits automatically)
  await context.close();
}

// CLI entry point - backward compatible
async function main() {
  const positionalEmail = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && a.includes('@'));
  const flagEmail = process.argv.find(a => a.startsWith('--email='))?.split('=')[1];
  const email = positionalEmail || flagEmail;

  if (!email) {
    console.error('Usage: npm run login user@example.com');
    console.error('       npm run login -- --email=user@example.com');
    process.exit(1);
  }

  await login(email);
  process.exit(0);
}

// Run main if executed directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[Login] Fatal error:', err);
    process.exit(1);
  });
}
