# Deepwork: Fix corrupted XML tool calling in streaming content filter

## Goal
Fix the streaming content filter pipeline that corrupts XML-based tool call syntax (`<function>`, `<parameter>`, etc.) when chunks arrive across SSE boundaries.

## Files
- `logs/gate/01.json` through `logs/gate/06.json` — request log files with corrupted processed output
- `src/utils/contentFilter.ts` — `filterContent` function
- `src/utils/xmlStripper.ts` — `stripToolCallArtifacts`
- `src/tools/xmlToolParser.ts` — `cleanTextOfXmlArtifacts`, `stripRemainingXmlMarkup`
- `src/routes/chatStreamingHelpers.ts` — `filterContentPipeline`, `processStreamData`
- `src/routes/streamLoop.ts` — `handlePostStreamCompletion` (flush path)

## Problem
XML tool call syntax from Qwen's output (`<function=name>`, `<parameter=name>` body `</parameter>` `</function>`) is chunked across SSE boundaries by the tokenizer. The per-chunk `filterContentPipeline` calls `cleanTextOfXmlArtifacts` and `filterContent` (→ `stripToolCallArtifacts`), which use regexes with `$` anchors that strip the LEADING `<function`/`<parameter` but leave ORPHANED TAIL fragments like `=read>\n`, `=filePath>`, etc.

Example from 03.json:
- Chunk: `"<function"` → `<function` at `$` → STRIPPED
- Next chunk: `"=read>\n"` → no leading `<` → SURVIVES as orphaned `=read>\n`

The flush path tries to correct this with `getSnapshotDelta`, but the common prefix matching creates DUPLICATE content instead.

## Fix applied
Added `skipXmlArtifactStripping` parameter to `filterContentPipeline` (chatStreamingHelpers.ts):
- Per-chunk call passes `true` → skips `cleanTextOfXmlArtifacts` AND `filterContent`, only runs `cleanThinkTags`
- `cleanThinkTags` only strips COMPLETE tags (with `>` or `\n`), not partial ones — no orphaned tails
- Partial XML tags survive per-chunk but are handled correctly on flush
- Flush call uses default `false` → full pipeline as before

## Phases
- [x] Phase 1: Read and analyze all 5 corrupt log files
- [x] Phase 2: Draft plan (exp-4 completed, reconciled)
- [x] Phase 3: Implement fix
- [x] Phase 4: Add tests using real chunks from all 5 logs
- [x] Phase 5: Validate + report

## Result
Fix applied. 15 new tests pass. 1 pre-existing test failure (unrelated).
