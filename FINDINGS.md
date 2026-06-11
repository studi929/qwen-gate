# Qwen Gate — Codebase Audit Findings

**Date:** 2026-06-11
**Auditors:** 6 parallel investigation agents (server/routes, services, tools, utils/middleware, config/CLI/tests, security)
**Total Findings:** ~130 issues across 12 source directories

---

## Executive Summary

| Severity | Count | Key Theme |
|----------|-------|-----------|
| **Critical** | 10 | Authentication bypass, rate limiter deadlocks, install.sh wrong project |
| **High** | 18 | Race conditions, NaN propagation, ReDoS, encryption weaknesses |
| **Medium** | 25 | Config drift, broken Docker build, partial validation, memory leaks |
| **Low** | 15+ | Dead code, stale scripts, test gaps, minor regex issues |

**Top 3 most urgent fixes:**
1. Dashboard/debug/config endpoints have NO authentication — anyone on the network can take over the service
2. Rate limiter creates a new mutex per request — concurrent requests bypass rate limiting entirely
3. `install.sh` is the wrong project (Hermes Agent installer, not Qwen Gate)

---

## Critical Findings (10)

### C1. Dashboard Config PUT Has No Authentication
**File:** `src/routes/dashboard/dashboardRoutes.ts:325-340`
The `PUT /api/config` route has zero auth middleware. Any network client can:
- Change all config values (PORT, HOST, BROWSER)
- Set `API_KEY` to empty string, disabling all auth
- Set `API_KEY` to a known value, hijacking the service

### C2. Empty API_KEY Default Bypasses All Authentication
**Files:** `config.json:4`, `src/index.tsx:91-93`
Ships with `"API_KEY": ""`. The auth middleware short-circuits when falsy — all `/v1/*` and `/api/accounts*` routes are completely unauthenticated by default.

### C3. Debug Network Endpoint Leaks Sensitive Data Without Auth
**File:** `src/routes/debugNetwork.ts`, registered at `src/index.tsx:98`
`/debug/network` and its SSE stream expose cookies, bearer tokens, request bodies, account emails to any unauthenticated client.

### C4. Dashboard Data Endpoints Have No Auth
**File:** `src/routes/dashboard/dashboardRoutes.ts:297-323`
`GET /accounts`, `/pool/stats`, `/system/logs`, `/log/json`, `/log/stream`, `/metrics/model-health` — all publicly accessible. `/log/json` returns raw prompts, request bodies, and credentials.

### C5. Rate Limiter Creates New Mutex Per Request
**File:** `src/middleware/rateLimit.ts:102`
`rateLimitMiddleware()` creates `new TokenBucket(key, config)` on every request. Each instance has its own promise chain lock. Concurrent requests get separate lock chains — rate limiting is effectively bypassed under load.

### C6. Rate Limiter tryConsume() Promise Hangs Forever
**File:** `src/middleware/rateLimit.ts:68-82`
No `.catch()` on the lock chain. If any previous `.then()` throws, the next `.then()` never fires, `resolve()` is never called, and the request deadlocks indefinitely.

### C7. install.sh Is the Wrong Project
**File:** `install.sh:1-1289`
The entire 1289-line file is the **Hermes Agent** installer by Nous Research. References `NousResearch/hermes-agent`, `HERMES_HOME`, `hermes-cli`, Python venvs. Does nothing useful for qwen-gate.

### C8. Circuit Breaker Race Condition
**File:** `src/utils/retry.ts:119-125`
`allowRequest()` is synchronous but state mutations (`recordSuccess`/`recordFailure`) are async with a promise-chain lock. `allowRequest()` bypasses the lock — during failure bursts, requests see stale "closed" state and pass through the open circuit.

### C9. Rate Limiter getHeaders() Reads Without Lock
**File:** `src/middleware/rateLimit.ts:84-94`
`getHeaders()` reads bucket state after the async `tryConsume()` resolves, but concurrent requests can modify tokens between the two calls, producing incorrect `X-RateLimit-Remaining` headers.

### C10. Log Store NaN Causes Unbounded Growth (OOM)
**File:** `src/services/logStore.ts:90`
If `MAX_LOGS` env var is non-numeric, `MAX_ENTRIES` becomes `NaN`. The eviction check `length > NaN` is always `false` — the in-memory log store grows without bound until OOM.

---

## High Findings (18)

### H1. Plaintext Passwords in Memory
**File:** `src/services/auth.ts:71`
`AccountEntry.password` stores passwords as plaintext strings for the process lifetime. Memory dumps expose all credentials.

### H2. Weak Encryption Key When API_KEY Is Empty
**File:** `src/services/accountManager.ts:98-103`
Without `API_KEY`, encryption key is `sha256(hostname + cwd)` — both guessable. Anyone who can read `accounts.json` can decrypt all passwords.

### H3. NaN Propagation from parseInt in auth.ts
**File:** `src/services/auth.ts:34-38`
Non-numeric config values produce `NaN`. All downstream arithmetic produces `NaN`, silently disabling timeouts, token age checks, and abort controllers. `setTimeout(() => abort(), NaN)` fires immediately.

### H4. Session Pool decrementInFlight Goes Negative
**File:** `src/services/sessionPool.ts:92-94`
When `email` is caller-provided, `pickAccount()` was NOT called (no `inFlight` increment), but error handler always calls `decrementInFlight()`. Over repeated failures, `inFlight` goes negative, permanently corrupting load-balancing.

### H5. Model Router Stale Health Metrics
**File:** `src/services/modelRouter.ts:91-110`
When a model hasn't been checked in >5 minutes, `isModelHealthy` returns `true` WITHOUT clearing stale error counts. A model with 99% error rate from 6 minutes ago is treated as healthy.

### H6. ReDoS in xmlStripper.ts
**File:** `src/utils/xmlStripper.ts:34`
Three `[\s\S]*?` non-greedy quantifiers separated by fixed anchors. Partial matches cause catastrophic backtracking — blocks the event loop for seconds on large tool-result echoes.

### H7. ReDoS in schemaValidators.ts (Regex Injection)
**File:** `src/tools/schemaValidators.ts:45,115`
`new RegExp(pattern).test(key)` compiles attacker-controlled regex strings. Malicious patterns like `(a+)+$` cause catastrophic backtracking.

### H8. Guard Removes All Duplicate Tool Calls (Including Legitimate)
**File:** `src/tools/guard.ts:73`
`valid = toolCalls.filter((_, i) => !indices.includes(i))` removes ALL occurrences of duplicated tool calls, not all-but-one. If the model was supposed to call the tool once, zero calls remain.

### H9. Lazy Parameter Regex Breaks on ` Lazy Parameter Regex Breaks on Closing Tag in Values
**File:** src/tools/xmlToolParser.ts:37
If a parameter value contains the literal closing parameter tag, the lazy regex matches prematurely, truncating the value and corrupting parsing.

### H10. Content Filter Strips Real Content
**File:** src/utils/contentFilter.ts:69-79
The Thinking: heuristic captures entire paragraphs as thinking content if the first line matches isStrongThinkingStart and no content marker follows. Real actionable content is silently discarded.

### H11. xmlStripper Destroys Apostrophes in JSON Repair
**File:** src/utils/xmlStripper.ts:74
fixed.replace(/'/g, double_quote) replaces ALL single quotes globally, breaking strings into invalid JSON.

### H12. Content Filter Missing > Guard
**File:** src/utils/contentFilter.ts:16
If > is not found, indexOf returns -1, making startTagEnd = 0. endTagName becomes a massive string. Downstream behavior is accidentally safe but fragile.

### H13. Dockerfile .dockerignore Excludes src/ Breaking Build
**Files:** .dockerignore:5, Dockerfile:5
.dockerignore excludes src/. The COPY . . in the build stage copies nothing, so npm run build fails.

### H14. Dockerfile CMD Binds localhost (Unreachable)
**File:** Dockerfile:18
CMD node dist/index.js without --host 0.0.0.0. In a container, binding to localhost makes the server unreachable from outside.

### H15. Dockerfile Env Var QWEN_GATE_PORT Never Read
**File:** Dockerfile:15
Sets ENV QWEN_GATE_PORT=26405 but the server reads config.get(PORT). The env var is ignored.

### H16. install.ps1 Copies JSONC to config.json
**File:** install.ps1:61-63
Copies config.example.jsonc (contains comments) to config.json. ConfigService calls JSON.parse(raw) directly - parse fails silently.

### H17. bin/qg Runs npm install on Every Invocation
**File:** bin/qg:17
Every qg command runs npm install - expensive and unnecessary for normal usage.

### H18. TokenBucket Creates New Instance Per Request (Mutex Broken)
**File:** src/middleware/rateLimit.ts:102
Same as C5 - the mutex is per-instance, not per-key. Concurrent requests each get their own lock chain.

---

## Medium Findings (25)

### Config and Build
| # | File:Line | Issue |
|---|-----------|-------|
| M1 | config.example.jsonc | Missing 7 config keys vs config.json |
| M2 | scripts/setup.js:9-26 | 8 stale default keys not in ConfigSchema |
| M3 | config.json vs setup.js | HOST default mismatch (empty vs localhost) |
| M4 | src/index.tsx:87 | CORS hardcoded to port 26405 - breaks if port changes |
| M5 | Dockerfile | Double-installs Chromium (Playwright + apk) |
| M6 | Dockerfile:12-14 | Does not copy config.json into image |
| M7 | Dockerfile | Runs as root (no USER directive) |

### Race Conditions and Concurrency
| # | File:Line | Issue |
|---|-----------|-------|
| M8 | src/services/auth.ts:125-126 | initAuth race - no mutex protects double-init |
| M9 | src/services/qwenModels.ts:72-99 | disableNativeTools race - two callers both execute API call |
| M10 | src/routes/config.ts:28-39 | Partial config mutation before validation rejects invalid keys |
| M11 | src/services/playwright.ts:315-322 | removeAccountContext does not await context close |
| M12 | src/routes/streamLoop.ts:48-53 | Promise.race timeout leaks timer on success |

### Logic Errors
| # | File:Line | Issue |
|---|-----------|-------|
| M13 | src/routes/config.ts:28-39 | Valid keys mutated in-memory before invalid key check fails |
| M14 | src/services/qwenModels.ts:166 | customInstructionApplied = true set on partial failure |
| M15 | src/services/sessionPool.ts:150 | pickAccount() increments inFlight but failure does not decrement |
| M16 | src/routes/accounts.ts:130-138 | Fire-and-forget async with no error handling |
| M17 | src/routes/accounts.ts:35,67 | POST and DELETE share same rate limit key |
| M18 | src/routes/chatNonStreaming.ts:301-308 | Log finalization ordering allows double finalization |

### Data Integrity
| # | File:Line | Issue |
|---|-----------|-------|
| M19 | src/services/logStore.ts:388-391 | readdirSync treats dirs as files - unlinkSync crashes |
| M20 | src/services/logStore.ts:386 | Filename collision at same-second granularity |
| M21 | src/routes/compressToolResult.ts:24 | Byte count vs char count mismatch in truncation marker |
| M22 | src/routes/chatStreamingHelpers.ts:273 | loggedToolCalls Set cleared at 500 - loses dedup mid-stream |
| M23 | src/services/networkDebug.ts:138-140 | O(n) linear scan for entry lookup during streaming |

### Validation Gaps
| # | File:Line | Issue |
|---|-----------|-------|
| M24 | src/services/configService.ts:149-151 | set() has no validation; invalid values propagate silently |
| M25 | src/services/configService.ts:138-147 | Env vars bypass all validation |

---

## Low Findings (18)

### Dead Code and Stale Files
| # | File:Line | Issue |
|---|-----------|-------|
| L1 | src/tests/parallel.test.ts:4-6 | Empty test file (comment only) |
| L2 | src/tools/parser.test.ts:1 | Empty test file (comment only) |
| L3 | scripts/debug-parser.ts:1 | Imports deleted module |
| L4 | scripts/*.py | 8 stale one-off debug/fix scripts |
| L5 | src/cli.ts:48-52 | findEntry() always returns .tsx; dist path is dead code |
| L6 | src/utils/retry.ts:276-278 | config.get() never returns undefined; guard is dead code |

### Test Quality
| # | File:Line | Issue |
|---|-----------|-------|
| L7 | src/tools/limiting.test.ts:20-41 | Tests local copy, not real truncateToolResult |
| L8 | Multiple test files | .js import paths inconsistent with .ts convention |
| L9 | src/middleware/rateLimit.ts | No test file at all |
| L10 | src/cli.ts | No test file |
| L11 | src/index.tsx | No test file |

### Minor Issues
| # | File:Line | Issue |
|---|-----------|-------|
| L12 | src/services/networkDebug.ts:63-64 | Cookie redaction leaks first 30 chars of session tokens |
| L13 | contentFilter.ts:75 | Single-line thinking kept but multi-line stripped |
| L14 | src/types/openai.ts:83 | reasoning_content missing null union |
| L15 | .github/workflows/ci.yml:2 | Triggers on all branches; no coverage reporting |
| L16 | .husky/pre-commit:3 | Runs full test suite (including Playwright) on every commit |
| L17 | src/routes/accounts.ts:4 | Account action rate limit Map never pruned |
| L18 | src/services/modelRouter.ts:29 | modelHealth map grows without bound |

---

## Recommended Priority Order

### Phase 1 - Security (Critical)
1. Add auth middleware to all dashboard routes and debug endpoints
2. Require non-empty API_KEY at startup or generate a random one
3. Fix TokenBucket to use singleton pattern per key (not per-request)
4. Add .catch() to rate limiter lock chain
5. Replace install.sh with actual qwen-gate installer
6. Fix .dockerignore to allow src/ in build context

### Phase 2 - Stability (High)
7. Fix decrementInFlight to track whether pickAccount() was called
8. Fix model health stale-reset logic (clear metrics when resetting window)
9. Fix content filter Thinking heuristic to preserve real content
10. Fix guard.ts to keep one copy of duplicate tool calls
11. Sanitize regex inputs in schemaValidators.ts (wrap in try/catch)
12. Fix circuit breaker to use same async lock as recordSuccess/recordFailure

### Phase 3 - Correctness (Medium)
13. Validate all parseInt calls for NaN
14. Fix initAuth race with promise guard pattern
15. Fix config route to validate all keys before mutating any
16. Add CORS config to use configured port
17. Fix Dockerfile (env var name, CMD --host, USER directive)
18. Fix readdirSync to filter out directories before unlink

### Phase 4 - Quality (Low)
19. Delete empty test files and stale scripts
20. Add tests for rate limiter, CLI, and server startup
21. Fix test imports to use consistent .ts extensions
22. Fix CI to only trigger on main branch pushes
23. Remove npm install from every bin/qg invocation
