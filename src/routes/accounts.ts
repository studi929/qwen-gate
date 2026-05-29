import { Hono } from 'hono';
import { getAccounts, addAccount, removeAccount, getAccountByEmail, loginFresh, saveCookies } from '../services/auth.ts';
import { openBrowserProfile } from '../services/playwright.ts';

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
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: { message: 'email and password are required' } }, 400);
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return c.json({ error: { message: 'email and password must be strings' } }, 400);
    }

    const result = await addAccount(email, password);
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

    console.log(`[Accounts] Opening browser for manual login: ${email}`);
    openBrowserProfile(account.email, undefined, { headless: false })
      .then(loginResult => {
        if (loginResult === 'success') {
          console.log(`[Accounts] Manual login completed for ${email}`);
        } else if (loginResult === 'captcha') {
          console.log(`[Accounts] CAPTCHA detected for ${email} — browser left open`);
        } else if (loginResult === 'closed') {
          console.log(`[Accounts] Browser closed by user for ${email}`);
        }
      })
      .catch(err => {
        console.error(`[Accounts] Manual login error for ${email}:`, err.message);
      });

    return c.json({
      success: true,
      email: account.email,
      message: 'Browser opened for manual login.'
    });
  } catch (err: any) {
    console.error('[Accounts] AUTOFILL failed:', err.message);
    return c.json({ error: { message: 'Auto-fill login failed' } }, 500);
  }
});
