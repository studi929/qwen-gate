# Token Counting Issues

The token counts reported by qwen-gate feel wrong compared to what the client expects. This documents the 5 root causes.

## 1. Prompt Inflation (Biggest problem)

qwen-gate **significantly inflates** your prompt before sending to Qwen's API, but `prompt_tokens` reflects the inflated size.

**Source**: `src/routes/chat.ts:337-434`

Your original messages get wrapped with:
- `User: ` / `Assistant: ` labels prepended to every message
- System prompt with global anti-XML instructions injected even when you don't send one
- `TOOL_FORMAT_INSTRUCTION` (~3KB of tool-calling rules) on every request with tools
- Tool definitions serialized into the prompt
- Conversation history rewritten — tool calls get wrapped in JSON, reasoning wrapped in `<think>` tags

**Example**: You send 500 chars → qwen-gate sends 2000+ chars to Qwen → Qwen counts tokens on 2000 chars → `prompt_tokens` is correct for what Qwen saw, but **2-4x higher than what you'd expect from your original input**.

## 2. Fallback Token Estimate Is a Rough Heuristic

```typescript
let promptTokens = Math.ceil(finalPrompt.length / 3.5);  // chat.ts:518, 845
```

This is the initial value before Qwen responds with actual usage. Problems with 3.5 chars/token ratio:

| Content Type | Actual Ratio | Effect |
|---|---|---|
| English prose | ~4 chars/token | Slight overestimate |
| Code/JSON | ~2-3 chars/token | **Overestimate by 15-40%** |
| Chinese text | ~1.5-2 chars/token | **Overestimate by 75-130%** |
| Mixed (Chinese + code) | Varies | Unpredictable |

If Qwen's SSE stream doesn't include a `usage` field (mid-stream error, certain model responses), **this fallback is what the client sees**.

## 3. No Context Window Enforcement

qwen-gate never checks if total tokens exceed the model's context window before sending.

**Source**: `src/routes/chat.ts:482` — prompt is sent straight to `createQwenStream()` with zero validation.

If `prompt_tokens + max_output_tokens > max_context`:
- The request silently fails at Qwen's API
- Error surfaces as a generic 502/upstream error
- No informative message about context overflow

The `context_window` values in `src/models.json` are **hardcoded estimates**, not fetched from Qwen's per-request limits. Qwen's `/api/models` endpoint could return different values at any time.

## 4. Reasoning Tokens Are a Character Estimate

```typescript
const reasoningTokensEstimate = reasoningBuffer
  ? Math.ceil(reasoningBuffer.length / 4)
  : 0;  // chat.ts:688, 1328
```

Assumes 4 characters = 1 token for reasoning content. This is rough because:
- Reasoning text is verbose with repetition (variable token density)
- No actual tokenizer is used
- The ratio varies throughout the response

## 5. `cached_tokens` Hardcoded to 0

```typescript
prompt_tokens_details: { cached_tokens: 0 }  // chat.ts:694, 1334
```

Qwen may support prompt caching (and actually use it), but qwen-gate never reports it. This makes `prompt_tokens` look higher than the net new tokens actually processed on each request.

---

## Summary Table

| What users expect | What actually happens |
|---|---|
| Your 100-char message → ~25 tokens | Your message + injected system prompt + tool instructions + formatting → 50-100+ tokens |
| Accurate token counts | Fallback heuristic (`length / 3.5`) used if Qwen's usage field is missing |
| Context window enforcement | None — qwen-gate sends blindly, Qwen may error with cryptic message |
| Prompt caching savings | Always reported as 0 cached tokens |
| Accurate reasoning tokens | `length / 4` character estimate |

## Related

- See `005 - Pain Points & Real Constraints.md` — tool calling prompt bloat (point #6) compounds the inflation
- See `006 - Improvement Map.md` — token counting fixes should go under "Quick Wins" or "Medium ROI"
