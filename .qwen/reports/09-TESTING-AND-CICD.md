# Testing & CI/CD — Analysis

## Current State

| Metric | Value |
|--------|-------|
| Total test files | 10 (out of ~68 source files) |
| Total test cases | ~90 |
| Coverage measurement | None |
| CI/CD | None |
| E2E tests | 0 |
| Integration tests | 6 (one file) |

## Files With Zero Test Coverage (Critical)

| File | Lines | Risk | Priority |
|------|-------|------|----------|
| `src/services/playwright.ts` | 432 | **CRITICAL** | P0 |
| `src/services/qwen.ts` | 342 | **CRITICAL** | P0 |
| `src/services/accountManager.ts` | 461 | **CRITICAL** | P0 |
| `src/services/sessionPool.ts` | 297 | **CRITICAL** | P0 |
| `src/services/auth.ts` | 386 | **CRITICAL** | P0 |
| `src/routes/chatNonStreaming.ts` | 345 | **CRITICAL** | P0 |
| `src/routes/chatStreamingHelpers.ts` | 297 | **CRITICAL** | P0 |
| `src/routes/streamLoop.ts` | 193 | **CRITICAL** | P0 |
| `src/routes/chatHelpers.ts` | 321 | **CRITICAL** | P0 |
| `src/routes/chatHelpersCore.ts` | 343 | **CRITICAL** | P0 |

## Files With Partial or No Tests (High Priority)

| File | Lines | Notes |
|------|-------|-------|
| `src/services/loginHelpers.ts` | 349 | 0 tests |
| `src/services/browserProfiles.ts` | 264 | 0 tests |
| `src/services/tokenRefresh.ts` | 117 | 0 tests |
| `src/services/modelRouter.ts` | 163 | 0 tests |
| `src/utils/retry.ts` | 374 | 0 tests (circuit breaker state machine!) |
| `src/utils/tokenEstimator.ts` | 228 | 0 tests |
| `src/middleware/rateLimit.ts` | 153 | 0 tests (token bucket algorithm!) |
| `src/routes/writeHelpers.ts` | 118 | 0 tests |

## Existing Test Quality

| Test File | Lines | Quality | Notes |
|-----------|-------|---------|-------|
| `xmlToolParser.test.ts` | 364 | HIGH | Real streaming data fixtures, thorough edge cases |
| `parser.test.ts` | 157 | HIGH | Numbered scenarios, streaming splits |
| `guard.test.ts` | 168 | HIGH | Comprehensive guard coverage |
| `configService.test.ts` | 173 | HIGH | All CRUD operations |
| `chat.amplification.test.ts` | 167 | HIGH | Amplification fix verification |
| `index.test.ts` | 324 | MODERATE | Integration tests, no timeout guard on stream read |
| `limiting.test.ts` | 149 | HIGH | Thorough boundary tests |
| `parallel.test.ts` | 42 | MODERATE | Potentially flaky (setTimeout timing) |
| `logStore.test.ts` | 44 | LOW | Only 2 tests on entry creation |
| `auth.test.ts` | 25 | VERY LOW | 3 "doesn't throw" tests on nonexistent accounts |

## Infrastructure Gaps

| Gap | Impact |
|-----|--------|
| No CI/CD pipeline | No automated test runs, no PR gating |
| No coverage reporting | Can't measure or enforce thresholds |
| No linting (ESLint/Biome) | Inconsistent code style, no automated quality checks |
| No pre-commit hooks | No type-checking or linting before commits |
| No Dockerfile | No reproducible test environment |
| No E2E tests | Real browser/Playwright interactions never tested |
| No test timeout guard | `index.test.ts` has a `while(true)` loop with no escape |

## Recommendations (Priority Order)

### P0 — Add tests for (no coverage, high business value):
1. `src/utils/retry.ts` — CircuitBreaker state machine needs tests
2. `src/services/sessionPool.ts` — Acquire/release/queue/timeout
3. `src/services/qwen.ts` — Error handling, rate limits, retry
4. `src/services/auth.ts` + `accountManager.ts` — Account selection, throttling, encryption
5. `src/middleware/rateLimit.ts` — Token bucket algorithm

### P1 — Add CI infrastructure:
1. GitHub Actions workflow: `npm ci` → `npx tsc --noEmit` → `npm test`
2. Coverage threshold enforcement
3. Pre-commit hook: type-check + lint

### P2 — Add E2E tests:
1. Playwright-based test that opens a real browser
2. Mock Qwen API for deterministic testing
