# Error Handling & Robustness — Bug Report

## Critical

### C1. Unhandled Promise in `sessionPool.release()`
- **File**: `src/services/sessionPool.ts:154`
- **[DISPUTED]**: The `Promise.all([...])` chain HAS a `.catch()` handler attached (line 158: `.catch(err => { console.error(...); waiter.reject(err); })`). Errors are caught and logged. Not an unhandled rejection.
- **Fix**: None needed for this specific claim. The fire-and-forget pattern is intentional.

### C2. No Global `unhandledRejection` Handler
- **Entire codebase**
- **Issue**: Node.js 15+ terminates process on unhandled rejections
- **Fix**: Add `process.on('unhandledRejection', ...)`

### C3. File System Race on Profile Directory
- **File**: `src/services/browserProfiles.ts:16-18`
- **Issue**: Multiple concurrent logins for same email race on `mkdirSync` and `cloakbrowser` lock files
- **Fix**: Add mutex per-email for profile operations

### C4. Unbounded `accountActionRateLimit` Map
- **File**: `src/routes/accounts.ts:4-15`
- **Issue**: Map grows unboundedly, timestamps accumulate per key without cleanup
- **Fix**: Periodically purge old entries, or use TTL-based Map

## High

### H1. Missing `AbortSignal` Timeout on `fetch()` Calls
- **File**: `src/services/qwenModels.ts:258`, `src/cli.ts:99`, `src/services/sessionPool.ts:271-275`
- **Issue**: Multiple fetch() calls lack timeout/abort signal
- **Impact**: Hanging upstream hangs the request forever
- **Validation**: 2/3 references lack timeout. `qwenModels.ts:258` DOES have a timeout via `createFetchTimeout()`. `cli.ts:99` and `sessionPool.ts:271-275` truly lack timeouts.
- **Fix**: Add timeout to `cli.ts:99` and `sessionPool.ts:271-275`

### H2. 30+ Empty Catch Blocks
- **Many files** (see full report for complete list)
- **Issue**: Widespread silent error swallowing, especially in:
  - `browserProfiles.ts` (12+ empty catches)
  - `loginHelpers.ts` (8+ empty catches)
  - `chatNonStreaming.ts`
- **Fix**: At minimum log errors before swallowing

### H3. `as any` Type Assertion Erosion
- **File**: `src/services/systemLogger.ts:122`, `src/routes/chatHelpers.ts:112`
- **Issue**: `as any` bypasses TypeScript safety in critical code paths

### H4. `ToolSpamGuard.history` Unbounded Growth
- **File**: `src/routes/chatHelpersCore.ts:145`
- **Issue**: Array grows indefinitely per session

### H5. Session Release Race
- **File**: `src/services/sessionPool.ts:137-167`
- **Issue**: Concurrent `release()` calls can double-count `inFlight` and `totalRequests`

### H6. `shell: true` in `spawn()` Calls
- **File**: `src/cli.ts:69-72,83,89,119`
- **Issue**: `shell: true` creates command injection risk if args contain user-controlled values

### H7. `body.model` Used Without Type Guard
- **File**: `src/routes/chatHelpers.ts:54,219,236`
- **Issue**: `body.model` assumed string without runtime validation

## Medium

### M1. `rateLimit.ts` Bucket Map Cleanup Delay
- **File**: `src/middleware/rateLimit.ts:14`
- **Issue**: Burst of unique keys causes memory spike before 15-min cleanup

### M2. `fetchQwenModels()` No Circuit Breaker
- **File**: `src/services/qwenModels.ts:230-293`
- **Issue**: Manual retry loop with jitter but no circuit breaker

### M3. Error Swallowing in `handleErrorResponse()`
- **File**: `src/services/qwen.ts:243-248`
- **[DISPUTED]**: Non-retryable errors are NOT silently swallowed. The catch block falls through to line 250 which throws `new UpstreamStatusError(...)`. Errors propagate correctly.
- **Fix**: None needed.

### M4. ReDoS Potential in `cleanTextOfXmlArtifacts`
- **File**: `src/tools/xmlToolParser.ts:55`
- **[DISPUTED]**: `[\s\S]*?` uses a **lazy** quantifier, not greedy. Lazy quantifiers expand forward one char at a time and do not cause catastrophic backtracking. The `$` anchor guarantees a match at end of string. Risk is low, not catastrophic.
- **Fix**: Low priority — real risk only on non-matching input with very long strings.

### M5. Busy-Poll Shutdown Loop
- **File**: `src/index.tsx:67-69`
- **Issue**: Polls every 100ms for up to 30s instead of event-driven

### M6. `scheduleCleanup` 200ms Race Window
- **File**: `src/services/cleanupHelpers.ts:43-51`
- **Issue**: Fixed delay could race with last SSE write
