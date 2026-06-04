# Bug: Echo Leak in Thinking Content

**Severity**: HIGH
**Status**: PARTIALLY FIXED (per old/05.md)
**Discovered**: 2026-06-03
**Source**: `output-bugs/old/05.md`

---

## Problem

The model sometimes echoes tool results inside `<think>` tags. The echo detection runs on `fullFilteredText` which is the **answer content only** (after `filterContent()` strips thinking). This means echoed tool results in thinking blocks stream to the user BEFORE echo detection can catch them.

## Evidence (from old/05.md)

```
Line 1168: if (isThinkingChunk) {
Line 1170:   reasoningBuffer += vStr;
Line 1171:   await writeEvent({...reasoning_content: vStr...});  ← LEAK HERE
...
Line 1268: const echoDetection = toolEchoFilter.detectEcho(fullFilteredText);
Line 1269: if (echoDetection.blocked) { abort... }
```

**Problem**: `filterContent()` at line 1258 strips `<thinking>` tags and returns `cleanText` (answer only). So `fullFilteredText` does NOT include thinking content. The echo filter only checks answer text, not reasoning.

## Previous Fix (old/05.md)

The fix moved thinking emission AFTER echo detection:
```
Line 1168-1177: Thinking detection (NO emission yet)
Line 1268: Echo detection on fullFilteredText
Line 1269: If blocked → abort + break (no emission)
Line 1314: filterText() creates echoFilteredText
Line 1318-1325: Thinking emission (AFTER echo check)
```

## Remaining Questions

1. Was this fix actually committed and merged?
2. Does `fullFilteredText` now include thinking content for echo detection?
3. Is the echo filter checking the raw accumulated text or only the filtered answer?

## Affected Code

| File | Lines | Issue |
|------|-------|-------|
| `src/routes/chatStreaming.ts` | 1168-1177 | Thinking emission order |
| `src/routes/chatStreaming.ts` | 1258-1268 | Echo detection on filtered text |
| `src/routes/pipeline/StreamingEchoFilter.ts` | — | What text does `detectEcho()` receive? |
| `src/utils/contentFilter.ts` | 1-5 | `filterContent()` strips thinking from `cleanText` |

## Verification Needed

1. Check current `chatStreaming.ts` — is thinking emission after echo detection?
2. Check `StreamingEchoFilter.detectEcho()` — does it receive thinking content?
3. Check if tests cover thinking+echo scenario
