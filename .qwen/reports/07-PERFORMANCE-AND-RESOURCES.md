# Performance & Resource Optimization — Analysis

## Top 5 Performance Priorities

### P1. Full Content Re-Processing Per Chunk (O(n·k) CPU)
- **File**: `src/routes/chatStreamingHelpers.ts:232,266`
- **Issue**: Every SSE chunk re-processes 100K string with `parseXmlToolCalls()` + `filterContentPipeline()` + `getSnapshotDelta()`
- **Impact**: 500 chunks × 100K chars = massive CPU waste
- **Fix**: Process deltas incrementally, only scan new content for tool calls

### P2. Synchronous File Writes in Hot Path
- **File**: `src/services/qwenLogger.ts:28,48`, `src/services/logStore.ts:386`
- **Issue**: `writeFileSync()` blocks event loop on every request
- **Impact**: Increases TTFB for all concurrent requests
- **Fix**: Use async `writeFile`, batch writes, or write queue

### P3. 30-Second Cookie Refresh for ALL Accounts
- **File**: `src/services/playwright.ts:239-243`
- **Issue**: Every 30s per account: `context.cookies()` IPC call + optional `page.goto()`
- **Impact**: With 20 accounts: 40 Playwright IPC calls/min, 20 page navigations
- **Fix**: Increase interval to 120-300s, add jitter

### P4. Double Chromium Launch Per Account at Startup
- **File**: `src/services/auth.ts:240-335`
- **Issue**: `loadCookiesFromProfile()` launches persistent context, then if no auth cookie calls `openBrowserProfile()` which launches another context
- **Impact**: N accounts × up to 3 browser launches on boot
- **Fix**: Eliminate redundant re-launch, reuse single context

### P5. Promise-Chain Mutex Unbounded Queue
- **File**: `src/services/accountManager.ts:344-376`
- **Issue**: `pickLock` Promise chain grows unbounded under concurrent load
- **Impact**: Micro-task queue buildup under load
- **Fix**: Replace with async-mutex library

## Memory Issues

| # | Location | Issue | Severity | Fix |
|---|----------|-------|----------|-----|
| M1 | `chatStreamingHelpers.ts:78` | `state.loggedToolCalls: Set<string>` never cleared during stream | HIGH | Clear periodically or at end of stream |
| M2 | `chatStreamingHelpers.ts:76` | `state.reasoningBuffer` grows unboundedly with entire reasoning content | HIGH | Cap size |
| M3 | `chatStreamingHelpers.ts:223` | `state.lastVStrRaw` has no size limit | HIGH | Apply 100K cap like `lastFullContent` |
| M4 | `chatHelpersCore.ts:145` | `ToolSpamGuard.history` never trimmed | MEDIUM | Trim on each `check()` |
| M5 | `services/modelHealth.ts:8-10` | Model health Maps never evicted | MEDIUM | Add periodic cleanup |
| M6 | `services/logStore.ts:340-390` | Per-request file logs have unbounded disk growth | MEDIUM | Add rotation/cleanup |
| M7 | `chatHelpersCore.ts:175` | `pendingCorrections` inner arrays never cleaned | LOW | Also trim inner arrays |

## CPU Issues

| # | Location | Issue | Impact | Fix |
|---|----------|-------|--------|-----|
| C1 | `chatStreamingHelpers.ts:232` | Full content re-parse per chunk | O(n²) | Incremental parsing |
| C2 | `xmlToolParser.ts:17` | `[\s\S]*?` regex backtracking | ReDoS on 100K input | Add timeout + simplify |
| C3 | `xmlStripper.ts:10-38` | 15 regex operations per call | Moderate | Combine patterns |
| C4 | `chatHelpersCore.ts:44-85` | Multiple fingerprint sizes per chunk | Low | Cache fingerprint |
| C5 | `chatStreamingHelpers.ts:227-229` | String `+=` creates O(n²) copy | Moderate | Use array/collector |

## Network Issues

| # | Location | Issue | Impact | Fix |
|---|----------|-------|--------|-----|
| N1 | `playwright.ts:239-243` | 30s cookie refresh per account | N×40 IPC calls/min | Increase to 120-300s + jitter |
| N2 | `sessionPool.ts:236-294` | Create + Delete session per chat turn | 9 extra API calls per 5-turn chat | Reuse sessions for multi-turn |
| N3 | `playwright.ts:384-396` | Extra fetch per account for bx-headers | 1 extra call per context creation | Capture headers from first real request |

## Concurrency Issues

| # | Location | Issue | Fix |
|---|----------|-------|-----|
| K1 | `accountManager.ts:344-376` | Promise-chain mutex unbounded queue | Use async-mutex |
| K2 | `auth.ts:186-198` | Phase 2 login has no concurrency limit | Add batch limit like Phase 1 |
| K3 | `playwright.ts:50`, `loginHelpers.ts:14` | 2 identical Mutex implementations | Extract to shared utility |
| K4 | `auth.ts:168-183` | Phase 1 default batch of 3 may be too low | Make configurable |

## File I/O Issues

| # | Location | Issue | Severity | Fix |
|---|----------|-------|----------|-----|
| I1 | `qwenLogger.ts:28,48` | `writeFileSync()` on every request | HIGH | Async writeFile |
| I2 | `logStore.ts:386` | `writeFileSync()` per finalized request | HIGH | Batch writes |
| I3 | `accountManager.ts:148` | `writeFileSync()` per account add/remove | LOW | Async |
| I4 | `qwenLogger.ts` | No log rotation/cleanup | MEDIUM | Add rotation |
