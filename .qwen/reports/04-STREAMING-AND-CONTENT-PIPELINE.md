# Streaming & Content Pipeline — Issues

## Medium

### M1. Full Content Re-Processing Per Chunk (O(n²) CPU)
- **File**: `src/routes/chatStreamingHelpers.ts:232,266`
- **Issue**: Every SSE chunk re-processes the ENTIRE accumulated content (up to 100K chars):
  - `parseXmlToolCalls(state.lastFullContent)` — scans 100K with complex regex
  - `filterContentPipeline(state.lastFullContent)` — calls `cleanTextOfXmlArtifacts()` + `filterContent()` + `cleanThinkTags()`
  - `getSnapshotDelta()` — char-by-char comparison on 100K strings
- **Impact**: For a 500-chunk response, the full 100K is processed 500 times
- **Fix**: Process deltas incrementally, only scan new content

### M2. RegEx ReDoS Potential in `xmlToolParser.ts`
- **File**: `src/tools/xmlToolParser.ts:17,55`
- **Issue**: `[\s\S]*?` with complex alternations can cause catastrophic backtracking on crafted input
- **Fix**: Add timeout guard, simplify regex

### M3. String Concatenation O(n²) Pattern
- **File**: `src/routes/chatStreamingHelpers.ts:227-229`
- **Issue**: `state.lastRawContent += rawText` creates a new string each chunk
- **Fix**: Use array push + join, or Map of segments

### M4. `detectCumulativeChunk()` Fingerprint Recovery on Every Chunk
- **File**: `src/routes/chatHelpersCore.ts:44-85`
- **Issue**: Tries multiple fingerprint sizes (64, 48, 32, 24) on every non-matching chunk
- **Fix**: Cache fingerprint, only scan when needed

### M5. `ToolSpamGuard.history` Unbounded Growth
- **File**: `src/routes/chatHelpersCore.ts:145`
- **Issue**: History array grows indefinitely, `window` only filters in `check()`, never trims
- **Fix**: Trim on each check

### M6. `pendingCorrections` Inner Arrays Never Cleaned
- **File**: `src/routes/chatHelpersCore.ts:175`
- **Issue**: Map trims to 500 entries every 5 min, but inner string arrays per key never cleaned
- **Fix**: Also trim inner arrays

## Low

### L1. `logIncomingRequest()` Is a No-op Called on Every Request
- **File**: `src/routes/chatHelpers.ts:315-321`
- **Fix**: Remove function or implement it

### L2. `logStore.createEntry()` Return Value Ignored
- **File**: `src/routes/chat.ts:184-185`
- **Fix**: Use the returned entry instead of double lookup (`logStore.getEntry(logId)`)

### L3. `scheduleCleanup` Uses Fixed 200ms Delay
- **File**: `src/services/cleanupHelpers.ts:43-51`
- **Issue**: Arbitrary delay could race with last SSE write
- **Fix**: Remove delay or make event-driven
