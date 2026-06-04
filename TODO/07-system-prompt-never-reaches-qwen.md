# Bug: System Prompt Never Reaches Qwen as System Message

**Severity**: CRITICAL
**Status**: OPEN
**Discovered**: 2026-06-03
**Source**: Browser inspection of chat.qwen.ai + code analysis

---

## Problem

The gateway builds a `systemPrompt` in `buildPromptAndSystem()` but never sends it as a system message. Instead, it concatenates it into the user message:

```typescript
// chatHelpers.ts line 1035
const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
```

This concatenated string is sent as the `content` of a single user message in the Qwen payload (`qwen.ts` line 121). Qwen sees it as a **user message**, not a system instruction.

## The Real System Prompt: Qwen's "Custom Instruction" API

Qwen has a **native system prompt mechanism** via the Personalization settings, accessible through the web UI at `https://chat.qwen.ai/settings/personalization`.

The "Custom instruction: How should Qwen behave?" field is a persistent, account-level system prompt that applies to **every conversation**.

### API Endpoints

**Read current settings:**
```
GET https://chat.qwen.ai/api/v2/users/user/settings
```

**Update settings (including system prompt):**
```
POST https://chat.qwen.ai/api/v2/users/user/settings/update
```

### Payload Structure

```json
{
  "personalization": {
    "name": "Youssef",
    "description": "User background info...",
    "style": "Default",
    "instruction": "You are a precise tool-calling assistant. Output tool calls as raw JSON only.",
    "enable_for_new_chat": true
  }
}
```

The `instruction` field is the system prompt. This is NOT injected into the conversation — it's stored server-side and prepended by Qwen's backend.

### Authentication

The API uses cookie-based auth (session cookies from the Playwright browser session). The same headers used for `disableNativeTools()` and `disablePersonalization()` work:

```typescript
const settingsHeaders = {
  'accept': 'application/json, text/plain, */*',
  'content-type': 'application/json',
  'cookie': headers['cookie'],
  'origin': 'https://chat.qwen.ai',
  'referer': 'https://chat.qwen.ai/',
  'user-agent': headers['user-agent'],
  'x-request-id': uuidv4(),
  'bx-ua': headers['bx-ua'],
  'bx-umidtoken': headers['bx-umidtoken'],
  'bx-v': headers['bx-v'],
};
```

### Existing Code Pattern

The gateway already uses this exact API in `src/services/qwenModels.ts`:
- `disableNativeTools()` — POSTs to disable native tool toggles
- `disablePersonalization()` — POSTs to disable memory/MCP

The same pattern can be reused to SET the custom instruction.

## What Qwen Actually Sends (from browser inspection)

When a user sends a message, Qwen's frontend sends:

```json
{
  "stream": true,
  "model": "qwen3.7-plus",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

The system prompt is **NOT in the messages array**. It's stored in the user's personalization settings and injected by Qwen's backend. This means:

1. **Prompt injection via `buildPromptAndSystem()` is the wrong approach** — the system prompt should be set via the personalization API
2. **The `systemPrompt` variable is currently wasted** — it's concatenated into the user message where Qwen treats it as user text, not system instructions
3. **Per-request system prompt changes are not possible** via this API — it's a persistent, account-level setting

## Fix Required

### Option A: Set System Prompt via Personalization API (Recommended)
Add a new function `setCustomInstruction(instruction: string)` that:
1. Takes the current gateway's system prompt content
2. POSTs it to `/api/v2/users/user/settings/update` as `personalization.instruction`
3. Runs on startup and when accounts are refreshed

**Pros**: System prompt is treated as a real system instruction by Qwen
**Cons**: Persistent across all conversations (can't change per-request)

### Option B: Hybrid Approach
1. Set a **minimal, persistent** system prompt via the API (anti-hallucination rules, format rules)
2. Keep the **per-request** system prompt in the user message for context-specific instructions
3. The API-level prompt handles the "always on" rules, the user message handles "this specific request" context

### Option C: Replace `buildPromptAndSystem()` Entirely
1. Move all system prompt logic to the personalization API
2. Simplify `buildPromptAndSystem()` to only build the user message (conversation history + tool results)

## Verification

1. Set the custom instruction via browser: "You are a tool-calling assistant. Output JSON tool calls."
2. Send a message requesting a tool call via the gateway
3. Verify the model outputs JSON tool calls instead of XML
4. Check if the instruction persists across conversations

## Files to Modify

| File | Change |
|------|--------|
| `src/services/qwenModels.ts` | Add `setCustomInstruction()` function |
| `src/routes/chatHelpers.ts` | Refactor `buildPromptAndSystem()` to separate persistent vs per-request instructions |
| `src/index.tsx` or startup | Call `setCustomInstruction()` on boot |
