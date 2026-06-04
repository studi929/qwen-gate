# Qwen Gate — Bug Tracker

All known bugs and issues documented in this folder.

## Bug List

| # | File | Severity | Status | Summary |
|---|------|----------|--------|---------|
| 1 | `01-xml-tool-call-hallucination.md` | CRITICAL | OPEN | Model hallucinates `<tool_calls>` XML and fabricates `<tool_result>` blocks |
| 2 | `02-tool-call-format-mismatch.md` | HIGH | OPEN | Model uses 3+ incompatible tool call formats (JSON, XML, `<function>`) |
| 3 | `03-processed-output-empty-tool-calls.md` | MEDIUM | OPEN | Empty `<tool_calls></tool_calls>` tags survive content filtering |
| 4 | `04-streaming-chunk-fragmentation.md` | MEDIUM | OPEN | Tool call JSON/XML arrives split mid-token across SSE chunks |
| 5 | `05-echo-leak-thinking-content.md` | HIGH | PARTIALLY FIXED | Echo detection misses tool result echoes inside `<think>` tags |
| 6 | `06-tool-result-fabrication.md` | CRITICAL | OPEN | Model invents tool results and acts on them as if real |
| 7 | `07-system-prompt-never-reaches-qwen.md` | CRITICAL | OPEN | System prompt concatenated into user message instead of using Qwen's native Personalization API |

## Priority Order

1. **Bug #7** (CRITICAL) — **ROOT CAUSE** — System prompt never reaches Qwen as a system instruction. It's concatenated into the user message. Fix: use `POST /api/v2/users/user/settings/update` with `personalization.instruction`.
2. **Bug #1 + #6** (CRITICAL) — Model fabricates tool calls AND results. Fix: use Qwen's native tool calling API + set correct system prompt via Personalization API.
3. **Bug #2** (HIGH) — Format inconsistency. Fix: standardize format via system prompt + Hermes-style template.
4. **Bug #5** (HIGH) — Echo leak in thinking. Fix: verify previous fix is merged.
5. **Bug #4** (MEDIUM) — Chunk fragmentation. Fix: add XML buffering to parser.
6. **Bug #3** (MEDIUM) — Empty wrapper tags. Fix: add regex to strip empty `<tool_calls>`.

## Root Cause Analysis

**Bug #7 is the root cause of bugs #1, #2, #3, #6.** The system prompt was never reaching Qwen as a system instruction.

### The Chain (Revised)

```
Gateway builds systemPrompt with tool-calling instructions
    → Concatenates into user message: systemPrompt + "\n" + prompt
    → Qwen sees it as USER TEXT, not system instructions
    → Model ignores format rules (they're just "user text")
    → Model writes <tool_calls> XML (its native format)
    → Model fabricates <tool_result> blocks
    → Gateway parser tries to extract JSON (misses XML)
    → Content filter strips XML (too late — model already acted on fabricated data)
    → User sees response based on imaginary tool execution
```

### The Fix

1. **Set system prompt via Personalization API** — `POST /api/v2/users/user/settings/update` with `personalization.instruction`
2. **Use Qwen's native tool calling format** — Hermes-style `<tool_call>` JSON, not the OpenAI format
3. **Remove tool call instructions from user message** — they belong in the system prompt
4. **Add anti-hallucination rules** — using positive instructions (not "NEVER do X")

### Key API Discovery

```
GET  /api/v2/users/user/settings           → Read current settings
POST /api/v2/users/user/settings/update    → Update settings (including system prompt)

Payload:
{
  "personalization": {
    "instruction": "Your system prompt here",
    "enable_for_new_chat": true
  }
}

Auth: Cookie-based (same Playwright session headers)
Existing pattern: qwenModels.ts disableNativeTools() / disablePersonalization()
```
