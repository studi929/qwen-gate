# Tool Calling Pipeline — Bug Report

## Critical

### C1. Entire `src/tools/parser.ts` Is Dead Code (329 lines)
- **File**: `src/tools/parser.ts`
- **Issue**: `StreamingToolParser` is only imported by `parser.test.ts`, never by production code
- **Impact**: 329 lines of maintenance burden. Production uses `xmlToolParser.ts` instead.
- **Fix**: Remove the file or wire it into production

### C2. Entire `src/tools/parserHelpers.ts` Is Dead Code (62 lines)
- **File**: `src/tools/parserHelpers.ts`
- **Issue**: `tryExtractToolCall` and `findBalancedJsonEnd` are never imported
- **Fix**: Remove or integrate

## High

### H1. Entire `src/tools/toolRunner.ts` Is Dead Code (149 lines)
- **File**: `src/tools/toolRunner.ts`
- **Issue**: `executeToolCalls`, `buildToolMessage`, `buildAssistantToolCallMessage`, `normalizeToolCalls`, `parseToolCallsFromContent` are never imported by production code
- **Fix**: Remove or wire up to a tool execution loop

### H2. `guard.ts` Dead Functions (80+ lines)
- **File**: `src/tools/guard.ts`
- **Issue**: `detectToolCallLoop`, `detectProviderToolLeak`, `validateToolCalls`, `buildCorrectionPrompt` are never called in production
- **Impact**: Important loop-detection logic not being used

### H3. Tool Call Index Collision in Streaming Path
- **File**: `src/routes/chatStreamingHelpers.ts:249`
- **Issue**: Tool call indices reset to `0` per chunk instead of being globally cumulative
- **Impact**: Clients (OpenAI SDK, Vercel AI SDK) overwrite tool calls from previous chunks
- **Fix**: Track a global counter `emittedToolCallCount + i` instead of `i`

### H4. `flush()` Ignores `passThrough` Flag
- **File**: `src/tools/parser.ts:273-282`
- **Issue**: `flush()` calls `flushStripXmlX()` even when `passThrough = true`
- **Impact**: Data corruption — tool calls extracted from raw passthrough text
- **Fix**: Add `if (this.passThrough) return { text: this.buffer, toolCalls: [], thinking: '' };`

## Medium

### M1. Buffer Trimming Failure When `offset` Goes Negative
- **File**: `src/tools/parser.ts:255-271`
- **Issue**: `compactBuffer()` can make `offset` negative → content never trimmed from buffer → O(n²) performance
- **Fix**: Handle negative offset with `offset = 0`

### M2. Unbounded Buffer Growth in `passThrough` Mode
- **File**: `src/tools/parser.ts:37`
- **Issue**: `passThrough` mode never calls `compactBuffer()` — buffer grows unboundedly
- **Fix**: Trim in `passThrough` mode too

### M3. Missing `crypto` Import in `xmlToolParser.ts`
- **File**: `src/tools/xmlToolParser.ts:87`
- **Issue**: `crypto.randomUUID()` used without import — relies on global `crypto` (Node 19+ only)
- **Fix**: Add `import crypto from 'node:crypto';`

### M4. `tryExtractToolCall` Hard-Coded 300-Character Lookback
- **File**: `src/tools/parserHelpers.ts:33`
- **Issue**: If JSON opening `{` is >300 chars before `"name"`, the tool call is silently dropped
- **Fix**: Increase lookback or scan for `{` globally

### M5. O(n²) XML Re-Parsing on Every Streaming Chunk
- **File**: `src/routes/chatStreamingHelpers.ts:232`
- **Issue**: `parseXmlToolCalls(state.lastFullContent)` re-parses the ENTIRE accumulated content (up to 100K chars) on every SSE chunk
- **Impact**: Significant CPU waste on long streams
- **Fix**: Parse incrementally from `lastParsedPosition`

### M6. Unbounded `state.lastVStrRaw` Growth
- **File**: `src/routes/chatStreamingHelpers.ts:223`
- **Issue**: `lastVStrRaw` has NO size limit (unlike `lastFullContent` with 100K cap)
- **Impact**: Memory leak on long streaming responses
- **Fix**: Apply similar size cap

### M7. `processToolCallsThroughGuard` Uses Hard-Coded `MAX_TOOL_CALLS_PER_TURN` (8)
- **File**: `src/routes/chatHelpersCore.ts:272,281-284`
- **Issue**: Initial truncation uses hard-coded 8, per-loop check uses `options.maxToolCalls`
- **Fix**: Use `options.maxToolCalls` for the initial truncation too

### M8. `validateToolCalls` All-or-Nothing Rejection
- **File**: `src/tools/guard.ts:49`
- **Issue**: When ANY tool call fails validation, ALL are discarded
- **Fix**: Return the accumulated `valid` array regardless

## Low

### L1. `extractSingleXmlToolCall` Matches Any XML Tag
- **File**: `src/tools/parser.ts:197`
- **Issue**: `/^<([A-Za-z][A-Za-z0-9_]*)>/` matches ANY valid XML tag as a tool call
- **Fix**: Whitelist known tool tag names

### L2. `detectParallelToolLoop` Removes First Occurrences Too
- **File**: `src/tools/guard.ts:146-149`
- **Issue**: When removing duplicates, the first 1-2 valid occurrences are removed too
- **Fix**: Keep the first occurrence, only remove excess

### L3. `compressJson` Only Samples First 3 Array Items
- **File**: `src/routes/compressToolResult.ts:49`
- **Fix**: Stratified sampling (head + middle + tail)
