# Fix Strategy for 02.md Tool Call Leak Pattern

> **Date**: 2026-05-30
> **Bug**: My own tool calls (bash, read, grep, glob) leaking as fragments like `bash", "arguments`
> **Status**: Root cause identified, fix in progress

---

## Root Cause Analysis

### The Leak Pattern

From `output-bugs/02.md`:
```
bash", "arguments
read", "arguments
grep", "arguments
glob", "arguments
": "bash",
name": "read"


These are **fragments from JSON serialization** of tool calls, not from structured `delta.tool_calls[]`.

### Why This Happens

**Two streaming paths exist in chat.ts:**

1. **Lines 43-215**: Uses `streamSSE` + `StreamingToolParser` ← **BUGGY PATH**
2. **Lines 1000-1146**: Uses raw `ReadableStream` + structured `delta.tool_calls[]` ← **CORRECT PATH**

The buggy path at **chat.ts:165** and **chat.ts:575**:

typescript
// Feed to parser for text-embedded tool calls
const result = parser.feed(delta.content);


The `StreamingToolParser` was designed for models like Claude that embed tool calls as JSON in text content. But:

1. **Qwen already provides structured `delta.tool_calls[]`** (handled correctly at lines 136-158)
2. The parser redundantly tries to extract tool calls from `delta.content`
3. When JSON fragments split across SSE chunks, the parser emits them as text
4. Even with `stripStreamingDelta()`, patterns like `bash", "arguments` escape

### The Redundancy

typescript
// Lines 136-158: Already handles structured tool calls correctly
if (delta.tool_calls && delta.tool_calls.length > 0) {
  const toolCallDelta = delta.tool_calls[0];
  
  if (toolCallDelta.id) {
    // Start new tool call
    currentToolCall = { id, function: { name, arguments } };
  } else {
    // Accumulate arguments
    currentToolCall.function.arguments += toolCallDelta.function.arguments;
  }
  
  continue; // Skip content emission
}

// Lines 161-178: Then redundantly tries to parse tool calls from content
if (delta.content) {
  accumulatedContent += delta.content;
  
  // THIS IS THE BUG — redundant parser
  const result = parser.feed(delta.content);
  
  // Emit any extracted tool calls
  for (const tc of result.toolCalls) {
    await emitToolCall(tc);
  }
  
  // Emit clean text (with tool calls removed)
  if (result.text) {
    const newText = result.text.substring(lastEmittedLength);
    if (newText) {
      await emitContent(newText);
      lastEmittedLength = result.text.length;
    }
  }
}


---

## The Fix

### Option 1: Remove StreamingToolParser (Recommended)

**Rationale**: Qwen provides structured `delta.tool_calls[]`. The text-embedded parser is only needed for models like Claude that don't support structured tool calls. Since qwen-gate is specifically for Qwen, the parser is unnecessary.

**Changes**:
1. Remove `const parser = new StreamingToolParser();` (line 49)
2. Remove `const result = parser.feed(delta.content);` (line 165)
3. Remove tool call emission loop (lines 167-169)
4. Simplify content emission to just emit `delta.content` directly
5. Remove `parser.flush()` call (line 187)

**Same changes at lines 575-598** (duplicate streaming path).

### Option 2: Keep Parser but Fix Fragment Leaks

**Rationale**: Keep support for text-embedded tool calls (future-proofing for other models).

**Changes**:
1. Enhance `stripStreamingDelta()` with more patterns:
   typescript
   cleaned = cleaned.replace(/[a-z_]+",\s*"arguments/g, '');
   cleaned = cleaned.replace(/":\s*"[a-z_]+",?/g, '');
   cleaned = cleaned.replace(/name":\s*"[a-z_]+/g, '');
   
2. Add buffer validation to parser to never emit partial JSON

**Problem**: This is a whack-a-mole approach. Every new tool name requires a new pattern.

---

## Recommended Approach: Option 1

**Why**:
1. **Simpler code** — removes 30+ lines of redundant logic
2. **Correct architecture** — consumes structured data, not text
3. **Matches production patterns** — NextChat, openai-node, Vercel AI SDK all use structured consumption
4. **No whack-a-mole** — no need to add patterns for every tool name

**Risk**: If Qwen ever changes to text-embedded tool calls, we'd need to re-add the parser. But this is unlikely — structured tool calls are the OpenAI standard.

---

## Implementation Plan

### Step 1: Write RED Test (TDD)

Create a test that reproduces the 02.md leak pattern:

typescript
test('streaming: tool call JSON fragments do not leak into content', async () => {
  // Simulate chunks with tool call JSON split across boundaries
  const mockChunks = [
    { delta: { content: 'I will use bash", "argum' } },
    { delta: { content: 'ents": {"command": "ls"}' } },
  ];
  
  const contentChunks = await simulateStreaming(mockChunks);
  const allContent = contentChunks.join('');
  
  // Verify no fragments leak
  assert.ok(!allContent.includes('bash", "arguments'), `Fragment leaked: "${allContent}"`);
  assert.ok(!allContent.includes('"arguments"'), `Fragment leaked: "${allContent}"`);
});


### Step 2: Implement GREEN Fix

Remove `StreamingToolParser` from both streaming paths in chat.ts.

### Step 3: SURFACE Verification

Manual QA with curl:
bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "List files in current directory"}],
    "stream": true
  }' | grep -E '(bash|read|grep|glob)", "arguments'


Expected: No matches (no fragments leak).

### Step 4: REGRESSION

Run full test suite to ensure no regressions.

---

## Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `src/routes/chat.ts` | 49 | Remove `const parser = new StreamingToolParser();` |
| `src/routes/chat.ts` | 165-169 | Remove parser.feed() and tool call emission |
| `src/routes/chat.ts` | 187-198 | Remove parser.flush() and final emission |
| `src/routes/chat.ts` | 575-579 | Remove parser.feed() and tool call emission (duplicate path) |
| `src/routes/chat.ts` | 598-609 | Remove parser.flush() and final emission (duplicate path) |

---

## Success Criteria

- [ ] RED test fails (proving bug exists)
- [ ] GREEN test passes (proving fix works)
- [ ] Manual QA shows no fragments in curl output
- [ ] Full test suite passes (no regressions)
- [ ] Code is simpler (30+ lines removed)

---

## References

- `output-bugs/02.md` — The leak pattern
- `output-bugs/PROFESSIONAL_STREAMING_PATTERNS.md` — Production patterns (NextChat, openai-node)
- `src/routes/chat.ts:136-158` — Correct structured tool call consumption
- `src/routes/chat.ts:165` — Buggy text-embedded parser usage
