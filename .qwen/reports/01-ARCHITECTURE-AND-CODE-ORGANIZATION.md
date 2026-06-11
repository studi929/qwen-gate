# Architecture & Code Organization Report

## Circular Dependencies

### C1. `services/auth.ts` ↔ `services/accountManager.ts`
- `auth.ts:10` imports from `./accountManager.ts`
- `accountManager.ts:9` imports from `./auth.ts`
- **Fix**: Extract shared types into a separate module, remove the mutual imports
- Dynamic imports at `accountManager.ts:195,242,265,274` and `auth.ts:100-101,105` are code smells

### C2. `services/auth.ts` ↔ `services/playwright.ts`
- `playwright.ts:4` imports from `./auth.ts`
- `auth.ts:10` imports from `./playwright.ts`
- Dynamic imports at `playwright.ts:253,291` hide the cycle

### C3. `services/logStore.ts` ↔ `services/systemLogger.ts`
- `logStore.ts:394` calls `__registerLogStore(logStoreInstance)`
- `systemLogger.ts:116-133` uses Proxy pattern that throws if logStore is accessed before init
- **Risk**: Runtime crash if import order changes

## Dead Code (Exported but Never Used)

| # | File | Symbol | Lines | Notes |
|---|------|--------|-------|-------|
| D1 | `src/routes/pipeline/StreamingContentFilter.ts` | Entire file | 141 | **Never imported anywhere** |
| D2 | `src/utils/tokenEstimator.ts` | `estimateTokensFast()` | 119 | Exported but never imported |
| D3 | `src/utils/tokenEstimator.ts` | `calculateTokenOverhead()` | 146 | Exported but never imported |
| D4 | `src/utils/xmlStripper.ts` | `stripStreamingDelta()` | 40 | Exported but never imported |
| D5 | `src/utils/xmlStripper.ts` | `repairMalformedJson()` | 71 | Exported but never imported |
| D6 | `src/utils/json.ts` | Entire file | 234 | **[DISPUTED]** — `parserHelpers.ts:3` imports `robustParseJSON` from `'../utils/json.ts'`. Not dead code. |
| D7 | `src/services/playwright.ts` | `loginToQwen()` | 349 | Never imported outside playwright.ts |
| D8 | `src/services/playwright.ts` | `getBrowserContext()` | 342 | Never imported anywhere |
| D9 | `src/services/playwright.ts` | `injectCookies()` | 328 | Never imported anywhere |
| D10 | `src/services/browserProfiles.ts` | `autoFillLogin()` | 261 | Never imported anywhere |

## Misnamed Modules

| File | Problem | Suggested Name |
|------|---------|----------------|
| `src/utils/auth.ts` | Contains API key auth (safeCompare), not Qwen auth | `src/utils/apiKeyAuth.ts` |
| `src/services/playwright.ts` | Named after library, actually browser session manager | `src/services/browserSession.ts` |
| `src/routes/chatHelpers.ts` | Contains core business logic, not helpers | `src/services/chatPipeline.ts` |
| `src/services/loginHelpers.ts` | Contains 3 complete login strategies | `src/services/loginStrategies.ts` |
| `src/services/networkDebug.ts` | Observability service, not debug | `src/services/networkObservability.ts` |

## Files > 400 Lines (Should Be Split)

| File | Lines | Suggested Split |
|------|-------|-----------------|
| `src/services/accountManager.ts` | 461 | Split into `encryption.ts`, `accountPicker.ts`, `accountWatcher.ts` |
| `src/services/playwright.ts` | 432 | Split context management from cookie/header handling |
| `src/services/logStore.ts` | 395 | Near threshold, clean up before adding features |

## Import Path Inconsistencies

5 files use `.js` extensions in imports (should be `.ts`):
- `src/services/auth.ts:11` — `'./logStore.js'`
- `src/services/sessionPool.ts:5` — `'./logStore.js'`
- `src/services/modelRouter.ts:7` — `'./logStore.js'`
- `src/services/logStore.test.ts:3` — `'./logStore.js'`
- `src/services/auth.test.ts:9` — `'./auth.js'`

## Duplicate Logic

| Pattern | Locations | Lines |
|---------|-----------|-------|
| `createFetchTimeout()` | `auth.ts:38`, `qwen.ts:93`, `qwenModels.ts:15` | 3 copies |
| `getSnapshotDelta()` | `chatHelpersCore.ts:87`, `StreamingContentFilter.ts:126` | 2 copies |
| `cleanThinkTags` regex | `chatHelpersCore.ts:119`, `thinkTagStripper.ts:36` | 2 copies |
| Mutex class | `playwright.ts:50`, `loginHelpers.ts:14` | 2 copies |

## Missing Barrel Exports

All directories lack `index.ts` barrel files:
- `src/services/` (20 files)
- `src/routes/` (14 files)
- `src/utils/` (9 files)
- `src/types/` (1 file)
- `src/tools/` (12 files)

## Orphaned Module

`src/routes/pipeline/StreamingContentFilter.ts` (141 lines) — complete file is never imported or referenced.
