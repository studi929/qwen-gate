import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { firefox } from 'playwright';

import {
  closePlaywright,
  createAccountContext,
  getActivePage,
  getBrowser,
  initPlaywright,
  refreshAccountCookies,
} from './playwright.ts';

test('page crash during account refresh detaches context and clears browser', async () => {
  process.env.TEST_MOCK_PLAYWRIGHT = '';

  const page = {
    route: async () => {},
    goto: async () => {
      throw new Error('page.goto: Page crashed');
    },
    evaluate: async () => 'ua-crashed',
  };

  const context = {
    newPage: async () => page,
    addCookies: async () => {},
    close: async () => {},
    cookies: async () => [],
  };

  const browser = {
    async newContext() {
      return context;
    },
    async close() {},
  };

  const launchMock = mock.method(firefox, 'launch', async () => browser);

  try {
    await closePlaywright();
    await initPlaywright(true, 'firefox');
    await createAccountContext('crash@example.com');

    await refreshAccountCookies('crash@example.com');

    assert.equal(getActivePage('crash@example.com'), null);
    assert.equal(getBrowser(), null);
  } finally {
    launchMock.mock.restore();
    await closePlaywright();
    delete process.env.TEST_MOCK_PLAYWRIGHT;
  }
});
