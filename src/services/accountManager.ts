/*
 * File: accountManager.ts
 * Account management extracted from auth.ts.
 * Handles account CRUD, discovery, persistence, and the account file watcher.
 */
import crypto from 'crypto';
import path from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmSync, watch, type FSWatcher } from 'fs';
import { loginFresh, saveCookies, loadSavedCookies, accounts, type AccountEntry } from "./auth.ts";
import { configureAccount } from './qwenModels.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { projectPath } from '../utils/paths.ts';
export let COOKIE_DIR = process.env.TEST_COOKIE_DIR || projectPath('qwen_profile', 'cookies');
const ACCOUNTS_FILE = projectPath('qwen_profile', 'accounts.json');

export function setCookieDir(dir: string): void {
  COOKIE_DIR = dir;
}
export function getCookieFilePath(email: string): string {
  const hash = crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return path.join(COOKIE_DIR, `${hash}.json`);
}
function getProfileDirForEmail(email: string): string {
  const safe = email.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  return projectPath('qwen_profile', 'chromium-profiles', safe);
}
export interface CookieData {
  email: string;
  token: string;
  refreshToken: string | null;
  savedAt: number;
  expiresAt: number;
}
interface PersistedAccountData {
  email: string;
  password: string;
}
export function parseAccountsFromEnv(): Array<{ email: string; password: string }> {
  const result: Array<{ email: string; password: string }> = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^ACCOUNT\d+$/i.test(key) || !value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const email = trimmed.substring(0, colonIdx).trim();
    const password = trimmed.substring(colonIdx + 1).trim();
    if (email && password) {
      result.push({ email, password });
    }
  }
  return result;
}
export function discoverSavedAccounts(): Array<{ email: string; password: string }> {
  try {
    const diskAccounts: Array<{ email: string; password: string }> = [];
    if (existsSync(COOKIE_DIR)) {
      const apiKey = config.get("API_KEY");
      const files = readdirSync(COOKIE_DIR).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = readFileSync(path.join(COOKIE_DIR, file), 'utf-8');
          let jsonStr = raw;
          // Try to decrypt if encrypted; fallback to raw for legacy files
          if (apiKey && raw.includes(':')) {
            try {
              jsonStr = decrypt(raw, apiKey);
            } catch {
              // Not encrypted or wrong key — use raw
            }
          }
          const data: CookieData = JSON.parse(jsonStr);
          if (data.email && data.token) {
            diskAccounts.push({ email: data.email, password: '' });
          }
        } catch (err) {
          console.error(`[Auth] Failed to parse saved account file ${file}:`, err);
        }
      }
    }
    const envAccounts = parseAccountsFromEnv();
    const merged = [...diskAccounts];
    for (const envAcct of envAccounts) {
      const existing = merged.find(a => a.email.toLowerCase().trim() === envAcct.email.toLowerCase().trim());
      if (existing) {
        existing.password = envAcct.password;
      } else {
        merged.push({ email: envAcct.email, password: envAcct.password });
      }
    }
    return merged;
  } catch {
    return [];
  }
}
/**
 * Decode a JWT token and return its payload, or null if invalid.
 */
export function decodeJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
/* ── AES-256-GCM password encryption ── */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function deriveKey(apiKey: string): Buffer {
  return crypto.scryptSync(apiKey, 'qwen-gate-salt', 32);
}

export function encrypt(plaintext: string, apiKey: string): string {
  const key = deriveKey(apiKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

export function decrypt(encryptedText: string, apiKey: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return encryptedText;
  const [ivHex, authTagHex, encrypted] = parts;
  try {
    const key = deriveKey(apiKey);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return encryptedText;
  }
}

// Backward-compatible aliases for existing callers
function encryptPassword(password: string, apiKey: string): string {
  return encrypt(password, apiKey);
}

function decryptPassword(encryptedText: string, apiKey: string): string {
  return decrypt(encryptedText, apiKey);
}

export function saveAccountsToFile(accounts: readonly AccountEntry[]): void {
  const dir = path.dirname(ACCOUNTS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const apiKey = config.get("API_KEY");
  const data: PersistedAccountData[] = accounts
    .filter(a => a.password)
    .map(a => ({ email: a.email, password: apiKey ? encryptPassword(a.password, apiKey) : a.password }));
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
export function loadAccountsFromFile(): Array<{ email: string; password: string }> {
  try {
    if (!existsSync(ACCOUNTS_FILE)) {
      return [];
    }
    const apiKey = config.get("API_KEY");
    const data: PersistedAccountData[] = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
    return data.filter(d => d.email && d.password).map(d => ({
      email: d.email,
      password: apiKey ? decryptPassword(d.password, apiKey) : d.password,
    }));
  } catch (err: any) {
    console.error('[Auth] Failed to load accounts file:', err.message);
    return [];
  }
}
export async function addAccount(
  email: string,
  password: string,
): Promise<{ loginSucceeded: boolean; loginError?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = accounts.find(a => a.email.toLowerCase().trim() === normalizedEmail);
  if (existing) {
    throw new Error(`Account with email ${normalizedEmail} already exists`);
  }
  const entry: AccountEntry = {
    email: normalizedEmail,
    password,
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
  };
  accounts.push(entry);
  saveAccountsToFile(accounts);
  const newState = await loginFresh(normalizedEmail, password);
  if (newState) {
    entry.state = newState;
    await saveCookies(normalizedEmail, newState.token, newState.refreshToken, newState.expiresAt);
    await configureAccount(normalizedEmail).catch(err =>
      console.error(`[Account] Failed to configure ${normalizedEmail}: ${err.message}`)
    );
    return { loginSucceeded: true };
  } else {
    const msg = `Login failed: wrong password or CAPTCHA required for ${normalizedEmail}. Check system logs.`;
    console.warn(`[Auth] ${msg}`);
    return { loginSucceeded: false, loginError: msg };
  }
}
export async function removeAccount(
  email: string,
): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const index = accounts.findIndex(a => a.email.toLowerCase().trim() === normalizedEmail);
  if (index === -1) {
    throw new Error(`Account with email ${normalizedEmail} not found`);
  }
  accounts.splice(index, 1);
  saveAccountsToFile(accounts);
  const cookieFile = getCookieFilePath(normalizedEmail);
  if (existsSync(cookieFile)) {
    try {
      unlinkSync(cookieFile);
    } catch (err: any) {
      console.error(`[Auth] Failed to delete cookie file for ${normalizedEmail}:`, err.message);
    }
  }
  const profileDir = getProfileDirForEmail(normalizedEmail);
  if (existsSync(profileDir)) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (err: any) {
      console.error(`[Auth] Failed to delete Chromium profile for ${normalizedEmail}:`, err.message);
    }
  }
}
/**
 * Re-scan COOKIE_DIR and merge changes into the live accounts array.
 */
export async function reloadAccounts(): Promise<void> {
  if (accountWatcher && !watcherReady) {
    return;
  }
  const discovered = discoverSavedAccounts();
  const discoveredEmails = new Set(discovered.map(d => d.email.toLowerCase().trim()));
  const existingEmails = new Set(accounts.map(a => a.email.toLowerCase().trim()));
  let added = 0;
  let removed = 0;
  for (const d of discovered) {
    const email = d.email.toLowerCase().trim();
    if (!existingEmails.has(email)) {
      const entry: AccountEntry = {
        email,
        password: d.password,
        state: null,
        lastUsed: 0,
        throttledUntil: 0,
        refreshInFlight: null,
        loginAttempt: 0,
        inFlight: 0,
        totalRequests: 0,
      };
      const savedState = await loadSavedCookies(email);
      if (savedState) {
        entry.state = savedState;
      }
      accounts.push(entry);
      added++;
    }
  }
  for (let i = accounts.length - 1; i >= 0; i--) {
    const acct = accounts[i];
    if (!discoveredEmails.has(acct.email.toLowerCase().trim())) {
      const cookieFile = getCookieFilePath(acct.email);
      if (existsSync(cookieFile)) {
        continue;
      }
      if (acct.inFlight > 0) {
        continue;
      }
      accounts.splice(i, 1);
      removed++;
    }
  }
}
let accountWatcher: FSWatcher | null = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let watcherReady = false;
/** Promise-chain mutex to prevent TOCTOU races in pickAccount */
let pickLock: Promise<any> = Promise.resolve();
/**
 * Set up fs.watch on COOKIE_DIR with 300ms debounce to detect account file changes.
 */
export function setupAccountWatcher(): void {
  if (accountWatcher) return;
  if (!existsSync(COOKIE_DIR)) {
    mkdirSync(COOKIE_DIR, { recursive: true });
  }
  try {
    accountWatcher = watch(COOKIE_DIR, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        reloadDebounceTimer = null;
        reloadAccounts().catch(err => {
          console.error(`[Auth] Hot-reload failed: ${err.message}`);
        });
      }, 500);
    });
    accountWatcher.on('error', (err) => {
      console.error(`[Auth] Account watcher error: ${err.message}`);
      try { accountWatcher?.close(); } catch {
        // non-blocking: watcher may already be closed
      }
      accountWatcher = null;
      watcherReady = false;
      setTimeout(() => {
        setupAccountWatcher();
      }, 10000).unref();
    });
    setTimeout(() => { watcherReady = true; }, 2000);
  } catch (err: any) {
    console.error(`[Auth] Failed to set up account watcher: ${err.message}`);
  }
}
/**
 * Enable hot-reload by starting the account file watcher.
 */
export function enableHotReload(): void {
  setupAccountWatcher();
}
export function resetWatcherState(): void {
  watcherReady = false;
}
const DEFAULT_THROTTLE_MS = parseInt(config.get('RATE_LIMIT_COOLDOWN_MS', '120000'), 10);
export function isAvailable(acct: AccountEntry): boolean {
  if (!acct.state) return false;
  if (acct.throttledUntil > Date.now()) return false;
  return true;
}
export function pickAccount(): Promise<AccountEntry | null> {
  return new Promise((resolve) => {
    pickLock = pickLock.then(() => {
      const available = accounts.filter(isAvailable);
      if (available.length === 0) {
        if (accounts.length === 0) {
          resolve(null);
          return;
        }
        let best: AccountEntry | null = null;
        for (const acct of accounts) {
          if (acct.state) {
            if (!best || acct.throttledUntil < best.throttledUntil) best = acct;
          }
        }
        resolve(best);
        return;
      }
      const idle = available.filter(a => a.inFlight === 0);
      const pool = idle.length > 0 ? idle : available;
      pool.sort((a, b) => {
        if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
        return (a.lastUsed || 0) - (b.lastUsed || 0);
      });
      const picked = pool[0];
      picked.inFlight++;
      picked.lastUsed = Date.now();
      resolve(picked);
    });
  });
}
export function incrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.inFlight++;
}
export function decrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct && acct.inFlight > 0) acct.inFlight--;
}
export function incrementTotalRequests(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.totalRequests++;
}
export function hasInFlight(email: string): boolean {
  const acct = getAccountByEmail(email);
  return acct ? acct.inFlight > 0 : false;
}
export function getAccountByEmail(email: string): AccountEntry | null {
  return accounts.find(a => a.email === email) || null;
}
export function throttleAccount(email: string, durationMs?: number): void {
  const acct = getAccountByEmail(email);
  if (!acct) return;
  const cooldown = durationMs || DEFAULT_THROTTLE_MS;
  acct.throttledUntil = Date.now() + cooldown;
  const remaining = Math.ceil(cooldown / 1000);
      logStore.log('warn', 'auth', `Throttled ${email} for ${remaining}s`);
}
export function isAccountThrottled(email: string): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return true;
  return acct.throttledUntil > Date.now();
}
export function getAccountStats(): Array<{
  email: string;
  authenticated: boolean;
  throttled: boolean;
  throttledRemainingMs: number;
  tokenExpiresInMs: number;
  lastUsedAgoMs: number;
  inFlight: number;
  totalRequests: number;
}> {
  const now = Date.now();
  return accounts.map(a => ({
    email: a.email,
    authenticated: a.state !== null,
    throttled: a.throttledUntil > now,
    throttledRemainingMs: Math.max(0, a.throttledUntil - now),
    tokenExpiresInMs: a.state ? Math.max(0, a.state.expiresAt - now) : 0,
    lastUsedAgoMs: a.lastUsed ? now - a.lastUsed : -1,
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
  }));
}
export function getAccountCount(): number {
  return accounts.length;
}
export function getAvailableCount(): number {
  return accounts.filter(isAvailable).length;
}
export function getAllAccountEmails(): string[] {
  return accounts.map(a => a.email);
}
export function getAccounts(): readonly AccountEntry[] {
  return [...accounts];
}
export async function getToken(): Promise<string | null> {
  const acct = await pickAccount();
  return acct?.state?.token || null;
}
export async function getTokenWithAccount(email?: string): Promise<{ token: string; email: string } | null> {
  let acct: AccountEntry | null;
  if (email) {
    acct = getAccountByEmail(email);
    if (acct && !isAvailable(acct) && acct.state) {
      // Account exists but throttled — still return it
    }
  } else {
    acct = await pickAccount();
  }
  if (!acct?.state?.token) return null;
  acct.lastUsed = Date.now();
  return { token: acct.state.token, email: acct.email };
}
