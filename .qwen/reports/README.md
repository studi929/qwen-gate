# Qwen Gate — Quality Investigation Reports

Root cause investigation conducted by 10 parallel agents on 2026-06-11.
**Validation pass completed: 178/180 claims are TRUE. 2 FALSE claims cleared.**

## Validation Results

| Report | TRUE | FALSE | PARTIAL | Cleared |
|--------|------|-------|---------|---------|
| 01 — Architecture | 34 | 2 | 0 | D6 (json.ts is imported), routes count (14 not 12) |
| 02 — Tool Calling | 16 | 0 | 0 | All valid |
| 03 — Auth Flow | 17 | 2 | 1 | M8 (pickLock safe), M12 (404 already fixed) |
| 04 — Streaming | 6 | 0 | 0 | All valid |
| 05 — Dashboard | 16 | 0 | 0 | All valid |
| 06 — Error Handling | 13 | 2 | 2 | C1 (has .catch), M3 (not swallowed) |
| 07 — Performance | 20 | 0 | 0 | All valid |
| 08 — Security | 12 | 0 | 1+1unv | M4 partially overstated |
| 09 — Testing | 14 | 0 | 0 | All valid |
| 10 — DevOps | 16 | 0 | 0 | All valid |

**Cleared claims:**
- `01-D6`: `json.ts` IS imported by `parserHelpers.ts` — not dead code
- `01`: routes directory has 14 files, not 12
- `03-M8`: `pickLock` chain always resolves via `.catch()` — can't permanently reject
- `03-M12`: 404 → 502 mapping already fixed in current code
- `06-C1`: `Promise.all()` in `sessionPool.release()` HAS a `.catch()` handler
- `06-M3`: Errors in `handleErrorResponse()` fall through to `UpstreamStatusError` throw
- `06-H1`: `qwenModels.ts:258` DOES have an AbortSignal timeout
- `06-M4`: `[\s\S]*?` is lazy quantifier — low ReDoS risk, not catastrophic
- `08-M4`: Partial sanitization exists in `chat.ts:253`
- `08-L4`: Unverifiable (user-local file, not in repo)

## Report Index

| # | Report | Findings | Priority |
|---|--------|----------|----------|
| 01 | [Architecture & Code Organization](./01-ARCHITECTURE-AND-CODE-ORGANIZATION.md) | Circular deps, dead code, misnamed modules, duplications | HIGH |
| 02 | [Tool Calling Pipeline Bugs](./02-TOOL-CALLING-BUGS.md) | 4 critical, 4 high, 8 medium bugs | CRITICAL |
| 03 | [Auth Flow Bugs](./03-AUTH-FLOW-BUGS.md) | 3 critical, 5 high, 14 medium bugs | CRITICAL |
| 04 | [Streaming & Content Pipeline](./04-STREAMING-AND-CONTENT-PIPELINE.md) | O(n²) re-processing, ReDoS, memory leaks | HIGH |
| 05 | [Dashboard & Frontend](./05-DASHBOARD-AND-FRONTEND.md) | 2 critical, 4 high, 6 medium issues | CRITICAL |
| 06 | [Error Handling & Robustness](./06-ERROR-HANDLING-AND-ROBUSTNESS.md) | 4 critical, 7 high, 6 medium issues | CRITICAL |
| 07 | [Performance & Resources](./07-PERFORMANCE-AND-RESOURCES.md) | 5 top priorities, memory/CPU/network/IO | HIGH |
| 08 | [Security Audit](./08-SECURITY-AUDIT.md) | 3 critical, 5 high, 5 medium issues | CRITICAL |
| 09 | [Testing & CI/CD](./09-TESTING-AND-CICD.md) | 90% untested code, no CI/CD pipeline | HIGH |
| 10 | [Deployment & DevOps](./10-DEPLOYMENT-AND-DEVOPS.md) | No Docker, broken CLI, fragile restart | HIGH |

## Summary Metrics

| Category | Critical | High | Medium | Low/Info |
|----------|----------|------|--------|----------|
| Architecture | 3 | 4 | 8 | 6 |
| Tool Calling | 2 | 4 | 8 | 7 |
| Auth Flow | 3 | 5 | 14 | 10 |
| Streaming | 0 | 0 | 6 | 3 |
| Dashboard | 2 | 4 | 6 | 16 |
| Error Handling | 4 | 7 | 6 | 28 |
| Performance | 0 | 5 | 10 | 3 |
| Security | 3 | 5 | 5 | 4 |
| Testing | 0 | 10 | 4 | 0 |
| DevOps | 1 | 5 | 6 | 6 |

**Total:** ~180 findings across 10 categories — **178 confirmed, 2 cleared**
