# Auth Flow — Bug Report

## Critical

### C1. Browser Context Leak on Account Removal
- **File**: `src/services/playwright.ts:19`, `src/services/accountManager.ts:220-237`
- **Issue**: `accountContexts` Map is never cleaned up when `removeAccount()` is called
- **Impact**: Chromium browser context stays open, `setInterval` keeps running forever
- **Fix**: Add cleanup hook or `closeContext()` call in `removeAccount()`

### C2. Unhandled Promise in UserAgent Extraction
- **File**: `src/services/playwright.ts:107-109`
- **Issue**: `Promise.race()` with timeout on `page.evaluate()` has no try/catch
- **Impact**: Timeout rejection crashes the caller
- **Fix**: Wrap in try/catch with fallback

### C3. Fire-and-Forget Promises in `SessionPool.release()`
- **File**: `src/services/sessionPool.ts:154,165`
- **Issue**: `Promise.all(...)` and `deleteSession(...)` are NOT awaited
- **Impact**: Counters (`activeCount`, `inFlight`) become unreliable
- **Fix**: Await both, add error handling

## High

### H1. TOCTOU Race in `pickAccount()`
- **File**: `src/services/accountManager.ts:344-376`
- **Issue**: `inFlight` is incremented AFTER `pickAccount()` returns, so two concurrent callers can pick the same account
- **Fix**: Move `incrementInFlight` inside the mutex

### H2. `initAuth` Permanently Sets `initDone = true` on Failure
- **File**: `src/services/auth.ts:124-125`
- **Issue**: If `initAuth()` fails partway, `initDone` stays `true` — no retry possible
- **Fix**: Only set `initDone = true` after successful completion, or add recovery path

### H3. Unbounded `accountContexts` Map
- **File**: `src/services/playwright.ts:19`
- **Issue**: Maps are only cleared in `closePlaywright()` — never on account removal
- **Impact**: Each entry holds BrowserContext + Page + 30s interval timer

### H4. No Concurrency Limit on Phase 2 Login
- **File**: `src/services/auth.ts:186-198`
- **Issue**: `Promise.allSettled()` on ALL accounts simultaneously can trigger Qwen rate limiting
- **Fix**: Add batch limit (like Phase 1's `MAX_CONCURRENT_PROFILE_LOADS = 3`)

### H5. Stale `watcherReady` Timer Leak
- **File**: `src/services/accountManager.ts:322`
- **Issue**: `setTimeout` for `watcherReady = true` can fire after watcher is reset
- **Fix**: Clear timeout on reset

## Medium

### M1. No-op `process.on('exit')` Handler
- **File**: `src/services/playwright.ts:179`
- **Fix**: Remove

### M2. No-op `splice` in `refreshAccountCookies()`
- **File**: `src/services/playwright.ts:300`
- **Issue**: `postCookies.splice(0, postCookies.length, ...postCookies)` is a no-op
- **Fix**: Remove

### M3. Circular Dependency: `auth.ts` ↔ `accountManager.ts`
- Both import from each other (see architecture report)

### M4. Mixed `.js` / `.ts` Import Extensions
- 5 files use `.js` extension for same modules (see architecture report)

### M5. Credential Exposure via Error Responses
- **Files**: `src/services/tokenRefresh.ts:52`, `src/services/qwen.ts:251-253`
- **Issue**: Qwen response body propagated in error messages, potentially leaking tokens
- **Validation**: `qwen.ts:250-253` — `UpstreamStatusError` includes `errText` (full response body) which could contain tokens. **Valid.** `tokenRefresh.ts:52` — the specific line reference is NOT an exposure point (only logs "HTTP refresh failed"). **Partially valid.**
- **Fix**: Redact sensitive data from error messages

### M6. Lock Error Silently Returns Null
- **File**: `src/services/auth.ts:331`
- **Issue**: Chromium profile lock error silently swallowed with no log
- **Fix**: Log the event before returning null

### M7. `saveCookies` Never Persists to Disk
- **File**: `src/services/auth.ts:337-364`
- **Issue**: Tokens only updated in memory, never written to disk
- **Impact**: On restart, all tokens must be re-acquired
- **Fix**: Optionally persist to disk as cache

### M8. `pickLock` Promise Chain Can Become Permanently Rejected
- **File**: `src/services/accountManager.ts:344-376`
- **[DISPUTED]**: The `.catch()` handler always resolves with `resolve(null)`. The chain can never become permanently rejected.
- Fix: Already safe — no action needed.

### M9. Config Read at Module Evaluation Time
- **File**: `src/services/auth.ts:33-34`
- **Issue**: `AUTH_TOKEN_MAX_AGE_MS` and `AUTH_REFRESH_BEFORE_MS` read at module parse time
- **Fix**: Read lazily or re-read on config change

### M10. `getCookies()` Returns First Context Only
- **File**: `src/services/playwright.ts:84-89`
- **Issue**: When called without email, returns cookies from first account only
- **Fix**: Aggregate cookies across all contexts or pick best

### M11. Password Hashed with Raw SHA-256
- **File**: `src/services/auth.ts:86`
- **Note**: SHA-256 without salt is trivially reversible via rainbow tables
- **Fix**: Use HMAC or bcrypt if possible

### M12. `404 Not_Found` Mapped to 502
- **File**: `src/services/qwen.ts:231`
- **[DISPUTED]**: Already fixed — `qwen.ts:231` correctly maps to `status = 404`. The route handler at `chat.ts:252` uses `err.upstreamStatus || 500`, so 404 is properly propagated.
- Fix: Already done.

### M13. `chatId` in URL Without Encoding
- **File**: `src/services/qwen.ts:167`
- **Fix**: Use `URLSearchParams`

### M14. `loadCookiesFromProfile` Double Opens Profile
- **File**: `src/services/auth.ts:270-306`
- **Issue**: Opens profile, closes it, opens again — ~2-3s extra latency
- **Fix**: Check if already in memory first
