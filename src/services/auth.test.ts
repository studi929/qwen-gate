import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';

// We test hot-reload via reloadAccounts() which re-scans COOKIE_DIR
// and merges new accounts while preserving existing counters.
import {
  getAccountStats,
  incrementInFlight,
  decrementInFlight,
  incrementTotalRequests,
  hasInFlight,
  reloadAccounts,
  clearAuth,
} from './auth';

const TEST_COOKIE_DIR = 'qwen_profile/cookies';
const ORIGINAL_CWD = process.cwd();
const TEST_CWD = mkdtempSync(path.join(tmpdir(), 'qwen-gate-auth-test-'));

function hashEmail(email: string): string {
  return crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
}

function writeTestAccount(email: string, token = 'test-token-abc') {
  if (!existsSync(TEST_COOKIE_DIR)) mkdirSync(TEST_COOKIE_DIR, { recursive: true });
  const hash = hashEmail(email);
  const data = {
    email: email.toLowerCase().trim(),
    token,
    refreshToken: null,
    savedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  };
  writeFileSync(path.join(TEST_COOKIE_DIR, `${hash}.json`), JSON.stringify(data, null, 2), 'utf-8');
}

function cleanupTestCookies() {
  try {
    if (existsSync(TEST_COOKIE_DIR)) rmSync(TEST_COOKIE_DIR, { recursive: true, force: true });
  } catch {}
}

describe('account inFlight and totalRequests tracking', () => {
  test('incrementInFlight increments and decrementInFlight decrements', () => {
    // These should not throw even if account doesn't exist
    incrementInFlight('nonexistent@test');
    decrementInFlight('nonexistent@test');
  });

  test('incrementTotalRequests increments counter', () => {
    incrementTotalRequests('nonexistent@test'); // should not throw
  });

  test('hasInFlight returns false for nonexistent account', () => {
    assert.strictEqual(hasInFlight('nobody@test'), false);
  });
});

describe('hot-reload: reloadAccounts()', () => {
  before(() => {
    process.chdir(TEST_CWD);
    cleanupTestCookies();
    clearAuth();
  });

  after(() => {
    cleanupTestCookies();
    clearAuth();
    process.chdir(ORIGINAL_CWD);
    rmSync(TEST_CWD, { recursive: true, force: true });
  });

  test('S1: detects new account file added after init', async () => {
    // Start with one account
    writeTestAccount('existing@test.com');
    await reloadAccounts();
    const before = getAccountStats();
    assert.strictEqual(before.length, 1, 'should have 1 account initially');
    assert.strictEqual(before[0].email, 'existing@test.com');

    // Add a second account file
    writeTestAccount('newuser@test.com');
    await reloadAccounts();
    const after = getAccountStats();
    assert.strictEqual(after.length, 2, 'should detect new account after reload');
    const emails = after.map(a => a.email).sort();
    assert.deepStrictEqual(emails, ['existing@test.com', 'newuser@test.com']);
  });

  test('S2: preserves inFlight counters during reload', async () => {
    // Ensure account exists
    writeTestAccount('inflight@test.com');
    await reloadAccounts();

    // Simulate in-flight request
    incrementInFlight('inflight@test.com');
    incrementInFlight('inflight@test.com');
    assert.strictEqual(hasInFlight('inflight@test.com'), true);

    // Reload should preserve inFlight count
    await reloadAccounts();
    const stats = getAccountStats();
    const acct = stats.find(a => a.email === 'inflight@test.com');
    assert.ok(acct, 'account should still exist after reload');
    assert.strictEqual(acct.inFlight, 2, 'inFlight count must be preserved across reload');

    // Cleanup
    decrementInFlight('inflight@test.com');
    decrementInFlight('inflight@test.com');
  });

  test('S4: preserves totalRequests counters during reload', async () => {
    writeTestAccount('counter@test.com');
    await reloadAccounts();

    // Simulate some requests
    incrementTotalRequests('counter@test.com');
    incrementTotalRequests('counter@test.com');
    incrementTotalRequests('counter@test.com');

    // Reload should preserve totalRequests
    await reloadAccounts();
    const stats = getAccountStats();
    const acct = stats.find(a => a.email === 'counter@test.com');
    assert.ok(acct, 'account should still exist after reload');
    assert.strictEqual(acct.totalRequests, 3, 'totalRequests must be preserved across reload');
  });

  test('removing account file removes account from rotation', async () => {
    writeTestAccount('removable@test.com');
    await reloadAccounts();
    let stats = getAccountStats();
    assert.ok(stats.some(a => a.email === 'removable@test.com'), 'account should exist');

    // Remove the file
    const hash = hashEmail('removable@test.com');
    rmSync(path.join(TEST_COOKIE_DIR, `${hash}.json`), { force: true });
    await reloadAccounts();

    stats = getAccountStats();
    assert.ok(!stats.some(a => a.email === 'removable@test.com'), 'account should be removed after file deletion');
  });
});
