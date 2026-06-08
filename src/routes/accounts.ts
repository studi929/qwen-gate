import { Hono } from 'hono';
import { getAccounts, addAccount, removeAccount, getAccountByEmail, loginFresh, saveCookies } from '../services/auth.ts';
import { openBrowserProfile } from '../services/playwright.ts';

const accountActionRateLimit = new Map<string, number[]>();

function checkRateLimit(key: string, maxPerMinute: number = 10): boolean {
  const now = Date.now();
  const window = 60_000;
  const timestamps = (accountActionRateLimit.get(key) || [])
    .filter(t => now - t < window);
  if (timestamps.length >= maxPerMinute) return false;
  timestamps.push(now);
  accountActionRateLimit.set(key, timestamps);
  return true;
}

export const accountsRouter = new Hono();

accountsRouter.get('/', (c) => {
  const accounts = getAccounts();
  const masked = accounts.map(a => ({
    email: a.email,
    passwordMasked: a.password ? '••••••••' : '',
    authenticated: a.state !== null && a.state.token !== '',
    tokenExpiresAt: a.state?.expiresAt || null,
    throttled: a.throttledUntil > Date.now(),
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
  }));
  return c.json({ count: masked.length, accounts: masked });
});

accountsRouter.post('/', async (c) => {
  try {
    if (!checkRateLimit('accounts')) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: { message: 'email and password are required' } }, 400);
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return c.json({ error: { message: 'email and password must be strings' } }, 400);
    }

    const result = await addAccount(email, password);

    openBrowserProfile(email.toLowerCase().trim(), password, { headless: true })
      .then(loginResult => {
        if (loginResult === 'success') {
          // intentional: success is already reflected in addAccount result, no additional action needed
        } else if (loginResult === 'captcha') {
          // intentional: CAPTCHA requires manual intervention, user must complete login via CLI
        } else if (loginResult === 'closed') {
          // intentional: browser closed before login completed, user must retry
        }
      })
      .catch(err => {
        console.error(`[Accounts] Persistent browser login error for ${email}:`, err.message);
      });

    return c.json({ success: true, email: email.toLowerCase().trim(), loginSucceeded: result.loginSucceeded, loginError: result.loginError }, 201);
  } catch (err: any) {
    if (err.message.includes('already exists')) {
      return c.json({ error: { message: err.message } }, 409);
    }
    console.error('[Accounts] POST failed:', err.message);
    return c.json({ error: { message: 'Failed to add account' } }, 500);
  }
});

/**
 * DELETE /api/accounts/:email
 * Remove an account by email
 */
accountsRouter.delete('/:email', async (c) => {
  try {
    if (!checkRateLimit('accounts')) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }
    const email = decodeURIComponent(c.req.param('email'));
    await removeAccount(email);
    return c.json({ success: true, email });
  } catch (err: any) {
    if (err.message.includes('not found')) {
      return c.json({ error: { message: err.message } }, 404);
    }
    console.error('[Accounts] DELETE failed:', err.message);
    return c.json({ error: { message: 'Failed to remove account' } }, 500);
  }
});

/**
 * GET /api/accounts/:email/login
 * Trigger browser login for a specific account
 */
accountsRouter.get('/:email/login', async (c) => {
  try {
    const email = decodeURIComponent(c.req.param('email'));
    const account = getAccountByEmail(email);

    if (!account) {
      return c.json({ error: { message: `Account ${email} not found` } }, 404);
    }

    if (!account.password) {
      return c.json({ error: { message: 'No password stored for this account' } }, 400);
    }

    const newState = await loginFresh(account.email, account.password);

    if (newState) {
      account.state = newState;
      await saveCookies(account.email, newState.token, newState.refreshToken, newState.expiresAt);
      return c.json({ success: true, email: account.email, authenticated: true });
    } else {
      return c.json({ error: { message: 'Login failed' } }, 500);
    }
  } catch (err: any) {
    console.error('[Accounts] LOGIN failed:', err.message);
    return c.json({ error: { message: 'Login failed' } }, 500);
  }
});

accountsRouter.get('/:email/autofill', async (c) => {
  try {
    const email = decodeURIComponent(c.req.param('email'));
    const account = getAccountByEmail(email);

    if (!account) {
      return c.json({ error: { message: `Account ${email} not found` } }, 404);
    }

    if (account.state?.token) {
      return c.json({ success: true, email: account.email, message: 'Account is already authenticated.' });
    }

    openBrowserProfile(account.email, account.password, { headless: false })
      .then(loginResult => {
        if (loginResult === 'success') {
          // intentional: success is already reflected in token save, no additional action needed
        } else if (loginResult === 'captcha') {
          // intentional: CAPTCHA requires manual intervention, user must complete login in browser
        } else if (loginResult === 'closed') {
          // intentional: browser closed before login completed, user must retry
        }
      })
      .catch(err => {
        console.error(`[Accounts] Login error for ${email}:`, err.message);
      });

    return c.json({
      success: true,
      email: account.email,
      message: 'Browser opened with credentials filled. Solve CAPTCHA or fix password if needed.'
    });
  } catch (err: any) {
    console.error('[Accounts] AUTOFILL failed:', err.message);
    return c.json({ error: { message: 'Auto-fill login failed' } }, 500);
  }
});
