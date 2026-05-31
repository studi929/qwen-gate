import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { v4 as uuidv4 } from 'uuid';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createQwenStream } from '../services/qwen.ts';
import { OpenAIRequest, Message, ModelSpec } from '../utils/types.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { validateSingleToolCall, detectParallelToolLoop } from '../tools/guard.ts';
import { filterContent, stripToolCallArtifacts, stripStreamingDelta } from '../utils/contentFilter.ts';
import { StreamingContentFilter } from './pipeline/StreamingContentFilter.ts';
import { ToolResultEchoFilter } from './pipeline/ToolResultEchoFilter.ts';
import { sessionPool } from '../services/sessionPool.ts';
import modelSpecs from '../models.json' with { type: 'json' };
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { pickAccount } from "../services/auth.ts";
import { checkContextWindow, estimateTokens } from '../utils/tokenEstimator.ts';

// Debug logging — enabled via DEBUG=true env var
function logDebug(label: string, data: any) {
  if (!process.env.DEBUG) return;
  const prefix = `[DEBUG ${new Date().toISOString()}]`;
  if (typeof data === 'string') {
    // Truncate long strings to 5000 chars
    const truncated = data.length > 5000 ? data.substring(0, 5000) + `\n... [truncated ${data.length - 5000} more chars]` : data;
  } else {
    const json = JSON.stringify(data, null, 2);
    const truncated = json.length > 5000 ? json.substring(0, 5000) + `\n... [truncated ${json.length - 5000} more chars]` : json;
  }
}

const STREAM_DEBUG_FILE = join(process.cwd(), 'output-bugs', 'log', 'stream-debug.log');
let _streamDebugDirReady = false;
function streamDebugLog(_sessionId: string, stage: string, data: string | Record<string, unknown>) {
  if (!process.env.DEBUG_STREAM) return;
  if (stage !== 'RAW_CHUNK') return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  try {
    if (!_streamDebugDirReady) {
      const dir = dirname(STREAM_DEBUG_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      _streamDebugDirReady = true;
    }
    appendFileSync(STREAM_DEBUG_FILE, `${payload}\n`);
  } catch (_e) { /* debug logging is best-effort */ }
}

// Truncate a value for safe logging (redact long strings, keep structure)
function safeTruncate(val: any, maxLen = 200): any {
  if (typeof val === 'string') {
    if (val.length > maxLen) return val.substring(0, maxLen) + '...';
    return val;
  }
  if (Array.isArray(val)) return val.map(v => safeTruncate(v, maxLen));
  if (val && typeof val === 'object') {
    const obj: any = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = safeTruncate(v, maxLen);
    }
    return obj;
  }
  return val;
}

export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

export function getNewContent(text: string, lastEmittedText: string): string {
  if (!text) return '';
  const commonLen = commonPrefixLen(text, lastEmittedText);
  if (commonLen < text.length) return text.substring(commonLen);
  return '';
}

export function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Robust cumulative chunk detection. Qwen sometimes sends the full growing text
 * in each chunk instead of incremental deltas. Prefix-only detection fails when
 * the filter reclassifies early content (changing the prefix). This fallback
 * checks if the new text contains the old text as a substring — if yes, it's
 * cumulative and we extract the delta from the end.
 *
 * Returns: { cumulative: boolean, delta: string }
 *   - cumulative=true: newText contains lastText, delta is the new tail
 *   - cumulative=false: treat as incremental or duplicate
 */
export function detectCumulativeChunk(
  newText: string,
  lastText: string
): { cumulative: boolean; delta: string } {
  if (!lastText || !newText) return { cumulative: false, delta: newText };

  // Fast path: exact duplicate only
  // BUGFIX: removed lastText.startsWith(newText) — it caused new tool calls
  // to be skipped when their first chunk was a prefix of accumulated text
  if (newText === lastText) {
    return { cumulative: false, delta: '' };
  }

  // BUGFIX: require exact prefix — loose shared-prefix caused false positives on consecutive tool calls
  if (newText.startsWith(lastText) && newText.length > lastText.length) {
    return { cumulative: true, delta: newText.substring(lastText.length) };
  }

  // Fallback: suffix containment — does newText contain lastText anywhere?
  // This handles the case where filter reclassified early content, changing the prefix,
  // but the bulk of lastText still appears in newText.
  // BUGFIX: tightened to 90% match / min 32 chars to prevent false positives
  if (newText.length > lastText.length && lastText.length >= 32) {
    // Use the LAST 64 chars of lastText as a fingerprint (avoid short false matches)
    const fingerprint = lastText.slice(-Math.min(64, lastText.length));
    const idx = newText.indexOf(fingerprint);
    if (idx !== -1) {
      // Found the fingerprint. The delta is everything after the end of where
      // lastText would end if it appeared at this position.
      const expectedEnd = idx + lastText.length;
      if (expectedEnd <= newText.length) {
        // Verify: check that newText starting at idx matches lastText closely enough
        // (allow for filter reclassification at the very start, up to 200 chars divergence)
        const candidateRegion = newText.substring(idx, idx + lastText.length);
        const suffixMatch = commonSuffixLen(candidateRegion, lastText);
        if (suffixMatch >= Math.min(lastText.length * 0.9, lastText.length - 4)) {
          // 90%+ suffix match → it's cumulative
          const delta = newText.substring(expectedEnd);
          return { cumulative: true, delta };
        }
      }
    }
  }

  return { cumulative: false, delta: newText };
}

/**
 * Suffix-aware snapshot diff: if the filter reclassified early content (changing
 * the prefix), use the longest common SUFFIX to find what's genuinely new at
 * the end. Falls back to detectCumulativeChunk for robustness.
 */
function getSnapshotDelta(newSnapshot: string, lastSnapshot: string): string {
  if (!newSnapshot) return '';
  if (!lastSnapshot) return newSnapshot;
  if (newSnapshot === lastSnapshot) return '';

  if (newSnapshot.length <= lastSnapshot.length) {
    return '';
  }

  if (newSnapshot.startsWith(lastSnapshot)) {
    return newSnapshot.substring(lastSnapshot.length);
  }

  const detection = detectCumulativeChunk(newSnapshot, lastSnapshot);
  if (detection.cumulative) return detection.delta;

  return '';
}

function cleanThinkTags(t: string): string {
  return t.replace(/<\/?(?:think|thinking|thought|tool_call|tool_use|function_call|tool)>/gi, '');
}

/**
 * Truncate large tool results to prevent context pollution.
 * Smart elision: keep head + tail with truncation marker.
 * Preserves UTF-8 character boundaries.
 */
export function truncateToolResult(
  content: string,
  maxBytes: number = 4096,
): string {
  if (!content) return '';
  const encoded = new TextEncoder().encode(content);
  if (encoded.length <= maxBytes) return content;

  const headBytes = Math.floor(maxBytes * 0.45);
  const tailBytes = Math.floor(maxBytes * 0.45);

  const headView = new Uint8Array(encoded.buffer, 0, headBytes);
  const head = new TextDecoder('utf-8', { fatal: false }).decode(headView);

  const tailStart = encoded.length - tailBytes;
  const tailView = new Uint8Array(encoded.buffer, tailStart, tailBytes);
  const tail = new TextDecoder('utf-8', { fatal: false }).decode(tailView);

  return `${head}\n... [truncated ${content.length - headBytes - tailBytes} chars] ...\n${tail}`;
}

/**
 * Sliding-window tool spam guard: detects when the same (tool, args) pair
 * is called repeatedly within a recent window. Checks BEFORE the call is
 * dispatched — the guard catches the loop pattern on the second repeat,
 * before any cost accrues.
 */
class ToolSpamGuard {
  private window: number;
  private threshold: number;
  private history: Array<{ key: string }>;

  constructor(window = 8, threshold = 2) {
    this.window = window;
    this.threshold = threshold;
    this.history = [];
  }

  /** Canonicalize args for deterministic hashing (sorted keys). */
  private canonicalize(args: any): any {
    if (typeof args !== 'object' || args === null) return args;
    if (Array.isArray(args)) return args.map(a => this.canonicalize(a));
    return Object.keys(args).sort().reduce((acc: any, key) => {
      acc[key] = this.canonicalize(args[key]);
      return acc;
    }, {});
  }

  /** Check a (tool, args) pair. Returns ok=false + correction prompt if it's a repeat. */
  check(tool: string, args: any): { ok: true } | { ok: false; correctionPrompt: string } {
    const key = `${tool}:${JSON.stringify(this.canonicalize(args))}`;
    const recent = this.history.slice(-this.window);
    const count = recent.filter(h => h.key === key).length + 1;
    this.history.push({ key });

    if (count > this.threshold) {
      return {
        ok: false,
        correctionPrompt:
          `[TOOL SPAM] Called "${tool}" with identical arguments ${count} times in the last ${this.window} calls. ` +
          `Stop repeating this call. Analyze the results you already have and respond to the user. ` +
          `Do NOT call "${tool}" again with the same arguments.`
      };
    }
    return { ok: true };
  }
}

/**
 * Map: chatId → correction prompts from the previous turn.
 * Injected into the next request from the same session so the model sees
 * feedback about guard rejections, loop warnings, and echo warnings.
 */
const pendingCorrections = new Map<string, string[]>();

// Always-injected tool calling format instruction — model must know the format even when no tools are provided
// so it can handle tool calls in multi-turn conversations correctly.
// HIGHEST PRIORITY: This is #1 rule. Incorrect format breaks the streaming pipeline.
// Only the correct JSON format is shown. Never mention alternative formats —
// showing them teaches the model about them and increases the chance they get used.
const TOOL_FORMAT_INSTRUCTION = `
## TOOL DISCIPLINE — HIGHEST PRIORITY

You are a precise tool-calling assistant. Follow these rules:

### 1. TOOL SELECTION
- Only call tools explicitly listed in your available_tools.
- Never invent new tool names or parameters.
- If uncertain about a parameter, ask for clarification instead of guessing.

### 2. OUTPUT FORMAT
When calling a tool, output ONLY a single line of raw JSON:
{"name": "read_file", "arguments": {"path": "src/main.ts"}}
{"name": "glob", "arguments": {"pattern": "**/*.ts"}}
{"name": "bash", "arguments": {"command": "ls -la"}}

Rules:
- "name" must be a plain string — the tool name
- "arguments" must be a JSON object — not a string, not a number
- Output each tool call on its own line, one JSON object per line
- Never wrap tool calls in fences, backticks, or XML tags
- Never output raw JSON with explanatory text around it

### 3. TOOL USAGE
You have a rich set of tools available. Call as many as needed to accomplish the task.
- Each tool call must be valid JSON with "name" and "arguments" fields on a single line.
- Prefer combining operations when it saves turns: one well-crafted "bash" command beats three separate tool calls.
- There is no hard limit on tool calls. Use them as needed, but be efficient.
- If a tool call fails validation, retry once with corrected parameters.

### 4. NO NARRATION
Do NOT write sentences like:
- "I'll use the X tool to..."
- "Let me search for..."
- "Based on the output of..."
- "The tool returned..."

The JSON tool call IS the communication. You may include a ONE-SENTENCE summary of what you found, but never describe the tool itself or what it did.

### 5. ERROR RECOVERY
If a tool call fails validation:
- Retry once with corrected parameters
- If it fails again, report the error clearly using the field-path format: "arguments.path: expected string, got number"
- Do not silently ignore errors

### 6. PRIVATE REASONING
Your private reasoning is never shown to the user — answer directly.
Do not prefix answers with "Thinking:", "I am", "Let me", or any reasoning text.

### 7. TOOL CALLING CYCLE — READ BEFORE CALLING
Calling a tool is a TWO-STEP process: (1) call the tool, (2) READ the result before deciding what to do next.

- After calling a tool, you will receive the result inside <tool_result> tags.
- READ the entire result before making your next move.
- If the result answers the user's question — STOP calling tools and respond to the user.
- If the result is incomplete or ambiguous — call ONE more tool to clarify.
- NEVER call multiple tools in a row without reading each result first.
- NEVER repeat the same tool call with identical arguments.
`;

function parseQwenErrorPayload(raw: string): { message: string; status: ContentfulStatusCode } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : (code === 'Not_Found' ? 404 : 502);
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body. Keep this as an explicit bad gateway
    // instead of silently returning an empty assistant message.
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }

  return null;
}

export async function chatCompletions(c: Context) {
  const logId = uuidv4();
  try {
    const body: OpenAIRequest = await c.req.json();
    // STREAMING env var overrides client's stream setting (true=force stream, false=force non-stream)
  let isStream = body.stream ?? false;
  if (process.env.STREAMING === 'true') isStream = true;
  else if (process.env.STREAMING === 'false') isStream = false;
  else if (process.env.NON_STREAMING === 'true') isStream = false;
    // TOOL_CALLING=false disables all tool call parsing — raw Qwen output passes through
    const toolCalling = process.env.TOOL_CALLING !== 'false';
    // CLEAN_OUTPUT=false skips safety pre-processing (backtick stripping) before parsing.
    // Only applies when TOOL_CALLING=true.
    const cleanOutput = toolCalling && process.env.CLEAN_OUTPUT !== 'false';
    // CONTENT_FILTER=false disables thinking/XML stripping and space collapsing.
    // Set this if the content filter is too aggressive and removes content you want to keep.
    const contentFiltering = process.env.CONTENT_FILTER !== 'false';
    
    const messages = body.messages || [];

    // Extract last user message content as a plain string (handles array content parts)
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const lastMsgContent = lastMsg ? (Array.isArray(lastMsg.content)
      ? lastMsg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ')
      : String(lastMsg.content ?? '')
    ) : '';

    const logEntry = logStore.createEntry(logId, body.model, isStream);
    logStore.log('info', 'request', 'Chat request: model=' + body.model + ' stream=' + isStream);
    logEntry.clientRequest = {
      messageCount: messages.length,
      roles: messages.map(m => m.role),
      hasTools: !!(body.tools?.length),
      toolNames: body.tools?.map(t => t.function.name) || [],
      tool_choice: body.tool_choice ? (typeof body.tool_choice === 'string' ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
      lastMessage: lastMsgContent ? safeTruncate(lastMsgContent, 300) : '',
      messages: messages.map(function(m) {
        var txt = Array.isArray(m.content)
          ? m.content.filter(function(p) { return p.type === 'text'; }).map(function(p) { return p.text; }).join(' ')
          : String(m.content ?? '');
        return { role: m.role, content: txt };
      }),
    };
    logEntry.rawRequestBody = JSON.stringify(body);

    if (process.env.DEBUG) {
      logDebug('INCOMING REQUEST', {
        model: body.model,
        stream: isStream,
        messageCount: messages.length,
        roles: messages.map(m => m.role),
        hasTools: !!(body.tools && body.tools.length),
        toolCount: body.tools?.length || 0,
        toolNames: body.tools?.map(t => t.function.name) || [],
        tool_choice: body.tool_choice,
        lastMessagePreview: messages.length > 0 ? safeTruncate(messages[messages.length - 1].content, 300) : null,
      });
    }
    const hasImages = messages.some(m => 
      Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url')
    );
    if (hasImages) {
      const modelId = (body.model as string).toLowerCase().replace(/\./g, '-').replace(/-no-thinking$/, '');
      const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
      const supportsImages = specs?.modalities.includes('image');
      if (!supportsImages) {
        const original = body.model;
        body.model = 'qwen3.6-plus' + (original.includes('-no-thinking') ? '-no-thinking' : '');
      }
    }

    const modelId = (body.model as string).toLowerCase().replace(/\./g, '-').replace(/-no-thinking$/, '');
    const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
    const maxContext = specs?.max_context || 131072;
    const maxOutput = specs?.max_output || 8192;

    const formattedMessages = messages.map(m => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n') : String(m.content ?? '') }));
    const estimatedTokens = estimateTokens(formattedMessages.map(m => m.content).join('\n'));
    const contextCheck = checkContextWindow(estimatedTokens, maxContext, maxOutput, body.model as string, formattedMessages);

    if (!contextCheck.ok) {
      return c.json({ error: { message: contextCheck.message, type: 'invalid_request_error', param: 'messages', code: 'context_window_exceeded' } }, 400);
    }

    const availableTokens = contextCheck.availableTokens;

    let prompt = '';
    let systemPrompt = '';
    const toolResultContents: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPrompt += (contentStr || '') + '\n\n';
      } else if (msg.role === 'user') {
        const sanitized = contentStr
          .replace(/<(?:system|instruction|prompt|rule)\b[^>]*>[\s\S]*?<\/(?:system|instruction|prompt|rule)>/gi, '')
          .replace(/<(?:think|thinking|thought|tool_call|tool_use|function_call|tool)\b[^>]*>[\s\S]*?<\/(?:think|thinking|thought|tool_call|tool_use|function_call|tool)>/gi, '')
          .replace(/^(?:System|Assistant|User|Human):\s*/gim, '')
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
        // Bug 2 fix: Token-aware truncation instead of hard 32,768 char limit.
        // Use conservative 3.0 chars/token ratio to stay within available tokens.
        const charLimit = Math.floor(availableTokens * 3.0);
        const truncated = sanitized.length > charLimit
          ? sanitized.substring(0, charLimit) + `\n\n[TRUNCATED: input exceeded ${charLimit} characters (model: ${body.model}, available tokens: ${availableTokens})]`
          : sanitized;
        prompt += `User: ${truncated || ''}\n\n`;
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || '';
        const reasoning = msg.reasoning_content;
        if (reasoning) {
          assistantContent = `${reasoning}\n\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: any = {};
             if (typeof args === 'string') {
               try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
             } else if (args && typeof args === 'object') {
               parsedArgs = args;
             }
             const payload = { name: tc.function?.name, arguments: parsedArgs };
             const toolCallStr = JSON.stringify(payload);
             assistantContent = assistantContent ? assistantContent + '\n' + toolCallStr : toolCallStr;
           }
        }
        prompt += `Assistant: ${assistantContent}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          // Look up tool name in history by tool_call_id
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j];
            if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(tc => tc.id === msg.tool_call_id);
              if (call) {
                toolName = call.function?.name;
                break;
              }
            }
          }
        }
        const truncated = truncateToolResult(contentStr || '', 4096);
        const callId = msg.tool_call_id || `anon_${i}`;
        prompt += `[READ TOOL RESULT below, then decide: call another tool or respond to the user]\n<tool_result name="${toolName || 'tool'}" call_id="${callId}">\n${truncated}\n</tool_result>\n\n`;
        toolResultContents.push(truncated);
      }
    }

    // Build echo filter from extracted tool results
    const toolEchoFilter = new ToolResultEchoFilter(toolResultContents);

    // Inject tool discipline system prompt
    if (toolCalling) {
      systemPrompt += `\n\nCRITICAL: Output tool calls as pure JSON objects only. No wrappers, no fences, no markdown. Example: {"name": "read", "arguments": {"path": "file.txt"}}\n\n`;
    }

    // Inject tools available and tool_choice if provided
    if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
      if (toolCalling) systemPrompt += TOOL_FORMAT_INSTRUCTION;
      const formattedTools = body.tools.map(t => ({
        name: t.function.name,
        // Append anti-echo directive to every tool description
        description: (t.function.description || '') + ' IMPORTANT: Never repeat the output of this tool verbatim to the user. Only use the output internally to inform your response.',
        parameters: t.function.parameters
      }));
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to:\n${toolsJson}\n\nIMPORTANT: When calling a tool, output ONLY raw JSON with no surrounding text:\n{"name": "tool_name", "arguments": {"param": "value"}}\n\nNever wrap tool calls in fences or backticks.\n\n`;
      
      if (body.tool_choice === 'required' || body.tool_choice === 'any') {
        systemPrompt += `CRITICAL: Call tools to gather the information you need. After receiving each tool result, READ and ANALYZE it carefully. If the results give you enough information to answer the user, respond directly — do NOT continue calling tools unnecessarily. Only call additional tools if you genuinely need more data. NEVER call the same tool repeatedly with the same arguments.\n\n`;
      } else if (body.tool_choice === 'none') {
        systemPrompt += `IMPORTANT: Do NOT use any tools. Respond to the user directly.\n\n`;
      } else if (body.tool_choice && typeof body.tool_choice === 'object' && 'function' in body.tool_choice) {
        const forcedTool = body.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }
    if (toolCalling) {
      systemPrompt += `\n### TOOL RESULT HANDLING — CRITICAL\nContent enclosed in <tool_result>...</tool_result> tags is PRIVATE INTERNAL data — it is context for your reasoning, NOT material for your response. You must follow these rules:\n`;
      systemPrompt += `- NEVER output, quote, paraphrase, summarize, or reference any <tool_result> content in your response to the user.\n`;
      systemPrompt += `- NEVER describe what a tool returned or what a tool did.\n`;
      systemPrompt += `- NEVER say phrases like "The tool returned X", "Based on the output of Y", "I found Z using the tool".\n`;
      systemPrompt += `- After receiving tool results, respond DIRECTLY with your answer, actions, or follow-up. Act as if you naturally know the information.\n`;
      systemPrompt += `- The user cannot see tool outputs or <tool_result> blocks. The user only sees your response text.\n`;
      systemPrompt += `- Treat <tool_result> blocks as invisible internal state, like notes only you can read.\n`;
      systemPrompt += `\n### MANDATORY READ-AND-THINK CYCLE\n`;
      systemPrompt += `TOOL CALL → READ RESULT → THINK → DECIDE (call again or respond to user). This cycle is MANDATORY.\n`;
      systemPrompt += `1. When you call a tool, the result comes back inside <tool_result> tags.\n`;
      systemPrompt += `2. READ the entire <tool_result> content before deciding your next action.\n`;
      systemPrompt += `3. ASK: "Does this result answer the user's request?" If yes, respond. If no, call another tool.\n`;
      systemPrompt += `4. Do NOT call multiple tools in a row without reading their results first.\n`;
      systemPrompt += `5. Do NOT call the same tool with the same arguments more than once — the result will not change.\n`;
      systemPrompt += `6. Every tool call MUST be driven by a genuine information need, not habit.\n`;
    }

    let finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;

    logEntry.promptToQwen = {
      systemPromptLength: systemPrompt.length,
      totalLength: finalPrompt.length,
      preview: (systemPrompt.length > 500 ? systemPrompt.substring(0, 500) + '...' : systemPrompt) + '\n\n' + 
               (prompt.length > 200 ? prompt.substring(0, 200) + '...' : prompt),
    };

    if (process.env.DEBUG) {
      logDebug('PROMPT TO QWEN', {
        systemPromptLength: systemPrompt.length,
        promptLength: prompt.length,
        totalLength: finalPrompt.length,
        systemPromptPreview: systemPrompt.length > 800 ? systemPrompt.substring(0, 800) + '...' : systemPrompt,
        userPromptPreview: prompt.length > 800 ? prompt.substring(0, 800) + '...' : prompt,
      });
    }

    const isThinkingModel = !body.model.includes('no-thinking');
    
    // Pick the best available account (round-robin, non-throttled, least-recently-used)
    const selectedAccount = pickAccount();
    const accountEmail = selectedAccount?.email;

    // Acquire a session bound to the selected account. Each session supports one active
    // generation at a time. Multi-account rotation distributes rate limits.
    const session = await sessionPool.acquire(accountEmail);
    // Inject correction prompts from the previous turn — guard rejections, loop warnings,
    // and echo warnings are fed back so the model sees its own mistakes.
    const prevCorrections = pendingCorrections.get(session.chatId);
    if (prevCorrections && prevCorrections.length > 0) {
      pendingCorrections.delete(session.chatId);
      const correctionsBlock = prevCorrections.map((c, i) => `${i + 1}. ${c}`).join('\n');
      systemPrompt += `\n### FEEDBACK FROM PREVIOUS TURN\nThe following issues were detected in your previous response. Address them now:\n${correctionsBlock}\n\n`;
    }
    // Recompute finalPrompt (may have changed due to pendingCorrections injection above)
    if (prevCorrections && prevCorrections.length > 0) {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }
    let nextParentId: string | null = session.parentId;
    const sessionHeaders = session.cachedHeaders;
    const resolvedEmail = session.accountEmail || accountEmail;

    logEntry.accountEmail = resolvedEmail || '';

    const emailLabel = resolvedEmail ? ` account=${resolvedEmail.split('@')[0]}` : '';

    // Route model through fallback chain with health-based selection
    const routedModel = await modelRouter.route(body.model);
    if (routedModel !== body.model) {
      // intentional: model substitution logged separately via modelRouter metrics
    }

    // Retry logic with exponential backoff for transient errors
    let stream: ReadableStream;
    let uiSessionId = session.chatId;
    try {
      const result = await createQwenStream(finalPrompt, isThinkingModel, routedModel, session.chatId, nextParentId, resolvedEmail);
      stream = result.stream;
      uiSessionId = result.uiSessionId;
      // Record success for health tracking
      modelRouter.recordSuccess(routedModel);
      // Account may have rotated during retry (rate limit → switch account)
      if (result.accountEmail && result.accountEmail !== resolvedEmail) {
        // intentional: account rotation tracked via sessionPool, no additional action needed
      }
    } catch (err: any) {
      // Record error for health tracking and potential degradation
      modelRouter.recordError(routedModel);
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
      throw err;
    }

    const completionId = 'chatcmpl-' + uuidv4();

    if (!isStream) {
      const reader = stream!.getReader();
      let nonStreamReleased = false;
      try {
      const decoder = new TextDecoder();

      let currentThoughtIndex = 0;
      let reasoningBuffer = '';
      let lastFullContent = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser();
      if (!toolCalling) toolParser.passThrough = true;
      if (!cleanOutput) toolParser.skipPreProcess = true;
      const toolCallsOut: any[] = [];
      const correctionPrompts: string[] = []; // Guard rejection messages for logging
      const toolSpamGuard = new ToolSpamGuard(); // Sliding-window dedupe
      const MAX_TOOL_CALLS_PER_TURN = 15; // Hard cap: prevent one turn from burning the budget

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);

            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
              }
              nextParentId = chunk['response.created'].response_id;
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              nextParentId = chunk.response_id;
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && 
                (targetResponseId === null || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;

              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  const rawNew = thoughts.slice(currentThoughtIndex).join('\n');
                  if (rawNew) {
                    const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
                    vStr = rawNew.substring(commonLen);
                    if (vStr) {
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  vStr = delta.content || '';
                  if (vStr) {
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;
              if (isThinkingChunk) {
                reasoningBuffer += vStr;
              } else {
                // Log ALL raw chunks from Qwen, not just ones with JSON markers
                logStore.addRawChunk(logId, vStr);
                if (process.env.DEBUG && (vStr.includes('"name"'))) {
                  logDebug('QWEN RAW CHUNK (non-streaming)', vStr);
                }
                const { toolCalls, thinking, text: parserText } = toolParser.feed(vStr);
                if (thinking) {
                  reasoningBuffer += thinking;
                }
                // Accumulate parser-extracted text without per-chunk filtering.
                // Filtering happens once at the end to avoid over-filtering
                // content that looks like thinking in isolation but is clearly
                // answer content in context.
                // Cumulative detection: if parserText already contains lastFullContent
                // as prefix, it's a cumulative chunk — replace instead of append.
                if (parserText) {
                  if (lastFullContent.length > 0) {
                    const detection = detectCumulativeChunk(parserText, lastFullContent);
                    if (detection.cumulative) {
                      lastFullContent = parserText;
                    } else if (detection.delta === '') {
                      // Duplicate — skip
                    } else {
                      lastFullContent += parserText;
                    }
                  } else {
                    lastFullContent = parserText;
                  }
                }
                  for (const tc of toolCalls) {
                  // Guard: validate tool call before sending to client
                  const guard = validateSingleToolCall(tc);
                  if (!guard.ok) {
                    console.log(`  [🚫 GUARD REJECT] ${tc.name}: ${guard.errors.join(', ')}`);
                    logStore.updateEntry(logId, entry => {
                      entry.errors.push(`Guard rejected tool call "${tc.name}": ${guard.errors.join(', ')}`);
                    });
                    // Store correction prompt for next turn
                    correctionPrompts.push(guard.correctionPrompt);
                    continue; // Skip — don't send to client
                  }
                  // Sliding-window dedupe: reject repeated (tool, args) before they reach the client
                  const spamCheck = toolSpamGuard.check(tc.name, tc.arguments);
                  if (!spamCheck.ok) {
                    console.warn(`  [🛑 TOOL SPAM] ${tc.name}: repeated call blocked`);
                    logStore.updateEntry(logId, entry => {
                      entry.errors.push(`Tool spam: "${tc.name}" called repeatedly with same args`);
                    });
                    correctionPrompts.push(spamCheck.correctionPrompt);
                    continue;
                  }
                  if (toolCallsOut.length >= MAX_TOOL_CALLS_PER_TURN) {
                    console.warn(`  [🛑 TOOL LIMIT] Hit ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn, dropping excess`);
                    correctionPrompts.push(`[TOOL CALL LIMIT] Reached maximum of ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn. Analyze existing results and respond to the user.`);
                    break;
                  }
                  toolCallsOut.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  });
                  logStore.updateEntry(logId, entry => {
                    entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
                  });
                  if (process.env.DEBUG) {
                    logDebug('PARSED TOOL CALL', { name: tc.name, arguments: tc.arguments });
                  }
                }
              }
            }
          } catch (e) {
            console.error('[Chat] Non-streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
          }
        }
      }

      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
        return c.json({ error: { message: upstreamError.message } }, upstreamError.status);
      }

      const { text: remainingText, toolCalls: remainingToolCalls, thinking: remainingThinking } = toolParser.flush();
      if (remainingText) {
        lastFullContent += remainingText;
      }
      if (remainingThinking) {
        reasoningBuffer += remainingThinking;
      }
      for (const tc of remainingToolCalls) {
        // Guard: validate tool call before sending to client
        const guard = validateSingleToolCall(tc);
        if (!guard.ok) {
          console.log(`  [🚫 GUARD REJECT flush] ${tc.name}: ${guard.errors.join(', ')}`);
          logStore.updateEntry(logId, entry => {
            entry.errors.push(`Guard rejected flush tool call "${tc.name}": ${guard.errors.join(', ')}`);
          });
          correctionPrompts.push(guard.correctionPrompt);
          continue;
        }
        // Sliding-window dedupe: reject repeated (tool, args) before they reach the client
        const spamCheck = toolSpamGuard.check(tc.name, tc.arguments);
        if (!spamCheck.ok) {
          console.warn(`  [🛑 TOOL SPAM flush] ${tc.name}: repeated call blocked`);
          logStore.updateEntry(logId, entry => {
            entry.errors.push(`Tool spam: "${tc.name}" called repeatedly with same args`);
          });
          correctionPrompts.push(spamCheck.correctionPrompt);
          continue;
        }
        if (toolCallsOut.length >= MAX_TOOL_CALLS_PER_TURN) {
          console.warn(`  [🛑 TOOL LIMIT flush] Hit ${MAX_TOOL_CALLS_PER_TURN} tool calls, dropping excess`);
          correctionPrompts.push(`[TOOL CALL LIMIT] Reached maximum of ${MAX_TOOL_CALLS_PER_TURN} tool calls per turn. Analyze existing results and respond to the user.`);
          break;
        }
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        });
      }
      // Parallel loop detection: check if the model called the same tool with
      // identical arguments 3+ times — a sign it's stuck in a loop
      if (toolCallsOut.length >= 3) {
        const parsedForLoopCheck: ParsedToolCall[] = toolCallsOut.map((tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
        }));
        const loopCheck = detectParallelToolLoop(parsedForLoopCheck);
        if (!loopCheck.ok) {
          console.warn(`  [🔄 PARALLEL LOOP] ${loopCheck.errors[0]}`);
          correctionPrompts.push(loopCheck.correctionPrompt);
          logStore.updateEntry(logId, entry => {
            entry.errors.push(`Parallel loop: ${loopCheck.errors[0]}`);
          });
        }
      }

      const reasoningTokensEstimate = reasoningBuffer ? Math.ceil(reasoningBuffer.length / 4) : 0;
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: { reasoning_tokens: reasoningTokensEstimate },
        prompt_tokens_details: { cached_tokens: 0 }
      };
      const { cleanText: baseFilteredContent, thinking: filteredReasoning } = contentFiltering
        ? filterContent(lastFullContent)
        : { cleanText: lastFullContent, thinking: '' };
      if (filteredReasoning) {
        reasoningBuffer = reasoningBuffer ? reasoningBuffer + '\n' + filteredReasoning : filteredReasoning;
      }
      // Safety net: strip any remaining JSON tool calls or Tool Response echoes
      // from the content before sending to the client. This catches any tool
      // call artifacts that the streaming parser might have missed.
      const echoFiltered = toolEchoFilter.filterText(baseFilteredContent);
      // Detect echo ratio and warn if >30% of output was tool result echoes
      const echoRatio = toolEchoFilter.getEchoRatio(baseFilteredContent);
      if (echoRatio > 0.3 && baseFilteredContent.length > 0) {
        const echoWarning = `[ECHO WARNING] ${Math.round(echoRatio * 100)}% of output was tool result echoes — suppressing. Review system prompt anti-echo directives.`;
        console.warn(`  [${echoWarning}]`);
        logStore.addError(logId, echoWarning);
        correctionPrompts.push(echoWarning);
      }
      const filteredContent = stripToolCallArtifacts(echoFiltered);
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : filteredContent };
      if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
      if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
      if (toolCallsOut.length) message.tool_calls = toolCallsOut;

      logStore.updateEntry(logId, entry => {
        entry.finalResponse = {
          finishReason: toolCallsOut.length ? 'tool_calls' : 'stop',
          toolCallCount: toolCallsOut.length,
          contentPreview: lastFullContent.length > 500 ? lastFullContent.substring(0, 500) + '...' : lastFullContent,
        };
        entry.remainingText = lastFullContent.length > 500 ? lastFullContent.substring(0, 500) + '...' : lastFullContent;
        entry.processedApiOutput = filteredContent;
        if (correctionPrompts.length > 0) entry.errors.push(...correctionPrompts);
      });

      if (process.env.DEBUG) {
        logDebug('OUTGOING RESPONSE', {
          finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop',
          content: lastFullContent.length > 500 ? lastFullContent.substring(0, 500) + '...' : lastFullContent,
          toolCalls: toolCallsOut.map((tc: any) => ({ name: tc.function?.name, args: tc.function?.arguments })),
          toolCallCount: toolCallsOut.length,
          usage,
        });
      }

      if (correctionPrompts.length > 0) {
        pendingCorrections.set(session.chatId, [...correctionPrompts]);
      }
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
      nonStreamReleased = true;
      // Persist raw vs processed output for debugging
      const logEntry = logStore.getRecent(1).find(e => e.id === logId);
      if (logEntry) logStore.persistRequest(logEntry);
      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        system_fingerprint: 'fp_qwen_gate',
        service_tier: 'default',
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
        }],
        usage
      });
      } finally {
        try { reader.cancel(); } catch {
          // intentional: cancel may fail if reader already closed, continue cleanup
        }
        try { reader.releaseLock(); } catch {
          // intentional: releaseLock may fail if already released, continue cleanup
        }
        if (!nonStreamReleased) {
          sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
        }
      }
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'close');

    return honoStream(c, async (streamWriter: any) => {
      let streamDone = false;
      let clientDisconnected = false;
      if (c.req.raw?.signal) {
        c.req.raw.signal.addEventListener('abort', () => {
          clientDisconnected = true;
          streamDone = true;
        });
      }
      let heartbeatInterval: any;
      let totalChunks = 0;
      let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let streamReleased = false;
      try {
      // Send heartbeat to prevent Cloudflare 524 timeout
      await streamWriter.write(': heartbeat\n\n');

      // Set up a periodic heartbeat to keep the connection alive during long thinking phases
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch (_e) {
          clearInterval(heartbeatInterval);
          streamDone = true;
        }
      }, 15000); // Every 15 seconds
      if (heartbeatInterval && typeof heartbeatInterval.unref === 'function') {
        heartbeatInterval.unref();
      }

      const writeEvent = async (data: any) => {
        if (clientDisconnected) return;
        try {
          await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          streamDone = true;
          throw e;
        }
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      // Send initial chunk
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        system_fingerprint: 'fp_qwen_gate',
        service_tier: 'default',
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      streamReader = stream.getReader();
      const reader = streamReader;
      const decoder = new TextDecoder();
      
      let inThinkingState = false;
      let thinkingFragments: Record<string, boolean> = {};
      let currentThoughtIndex = 0;
      let currentAppendPath = '';
      
      let reasoningBuffer = '';
      let lastFullContent = '';
      let lastRawContent = '';  // pre-parser cumulative tracking
      // Snapshot-based diffing: track the full filtered text from the previous
      // iteration rather than accumulating emitted deltas. This prevents the
      // exponential amplification bug where filterContent() reclassifying early
      // content (e.g., "I am analyzing..." → thinking) changes the prefix,
      // causing getNewContent() to re-emit the entire text as "new".
      let lastFilteredSnapshot = '';
      let lastThinkingSnapshot = '';
      const enableContentFiltering = contentFiltering;
      const enableToolCalling = toolCalling;
      const enableCleanOutput = cleanOutput;
      // Stateful content filter: maintains high-water mark across chunks for cleaner architecture.
      // Note: The filter still processes full text internally; the architectural benefit is
      // stateful design and delta-based API. True O(n²)→O(n) optimization requires deeper
      // changes to filterContent() internals (incremental regex on unconfirmed tail only).
      const streamFilter = new StreamingContentFilter(enableContentFiltering);
      // Pre-parser cumulative tracking: detect cumulative vStr BEFORE feeding parser
      // to prevent parser buffer from growing quadratically.
      let lastVStrRaw = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser();
      if (!toolCalling) toolParser.passThrough = true;
      if (!cleanOutput) toolParser.skipPreProcess = true;

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      // Amplification guard: track raw input bytes vs emitted output bytes.
      // If emitted > raw*3 + 1000, suppress further text emission.
      let rawInputBytes = 0;
      let emittedOutputBytes = 0;
      let amplificationGuardTriggered = false;

      while (true) {
        if (streamDone) break;
        if (c.req.raw?.signal?.aborted) { reader.cancel(); break; }

        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          const IDLE_TIMEOUT_MS = 60_000;
          const readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('Upstream stream idle timeout — no data for 60s')), IDLE_TIMEOUT_MS);
            })
          ]);
          done = readResult.done;
          value = readResult.value;
        } catch (readErr: any) {
          throw readErr;
        }

        if (done) {
          break;
        }
        totalChunks++;
        if (value) rawInputBytes += value.length;

        const rawDecoded = decoder.decode(value, { stream: true });
        streamDebugLog(completionId, 'WIRE_CHUNK', { chunkNum: totalChunks, byteLen: value?.length ?? 0, preview: rawDecoded.substring(0, 300) });
        buffer += rawDecoded;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            streamDone = true;
            break;
          }

          try {
            const chunk = JSON.parse(dataStr);
            streamDebugLog(completionId, 'SSE_EVENT', { phase: chunk.choices?.[0]?.delta?.phase, hasContent: !!chunk.choices?.[0]?.delta?.content, hasToolCalls: !!chunk.choices?.[0]?.delta?.tool_calls, contentLen: chunk.choices?.[0]?.delta?.content?.length ?? 0, dataPreview: dataStr.substring(0, 300) });

            if (chunk.choices?.[0]?.delta?.status === 'finished') {
              const deltaPhase = chunk.choices[0].delta.phase;
              // 'thinking_summary' finished just means thinking is done — content (answer) comes next.
              if (deltaPhase !== 'thinking_summary') {
                streamDone = true;
                break;
              }
            }

            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
              }
              nextParentId = chunk['response.created'].response_id;
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              nextParentId = chunk.response_id;
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && 
                (targetResponseId === null || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;
              
              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  const rawNew = thoughts.slice(currentThoughtIndex).join('\n');
                  if (rawNew) {
                    const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
                    vStr = rawNew.substring(commonLen);
                    if (vStr) {
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  vStr = delta.content || '';
                  if (vStr) {
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;

              if (isThinkingChunk) {
                inThinkingState = true;
                reasoningBuffer += vStr;
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: vStr })]
                });
              } else {
                inThinkingState = false;
                // Strip stray tag closers that arrive as separate chunks after the
                // content has been parsed.
                if (/^[\n\s]*<\/?(?:think|thinking|thought|tool_call|tool_use|function_call)[\s>]*[\n\s]*$/.test(vStr)) continue;

                // Log ALL raw chunks from Qwen, not just ones with JSON markers
                logStore.addRawChunk(logId, vStr);
                streamDebugLog(completionId, 'RAW_CHUNK', vStr);
                if (process.env.DEBUG && (vStr.includes('"name"'))) {
                  logDebug('QWEN RAW CHUNK (streaming)', vStr);
                }
                // Pre-parser cumulative detection on vStr: if vStr contains lastVStrRaw
                // as prefix or suffix, extract only delta to prevent parser buffer bloat.
                let feedStr = vStr;
                if (lastVStrRaw.length > 0) {
                  const detection = detectCumulativeChunk(vStr, lastVStrRaw);
                  streamDebugLog(completionId, 'CUMULATIVE_DETECT', { cumulative: detection.cumulative, deltaLen: detection.delta.length, lastLen: lastVStrRaw.length, newLen: vStr.length });
                  if (detection.cumulative) {
                    feedStr = detection.delta;
                    lastVStrRaw = vStr;
                  } else if (detection.delta === '') {
                    // Duplicate vStr — skip parser feed entirely
                    feedStr = '';
                  } else {
                    // Incremental vStr
                    lastVStrRaw += vStr;
                  }
                } else {
                  lastVStrRaw = vStr;
                }
                const { text: rawText, toolCalls, thinking: parserThinking } = feedStr ? toolParser.feed(feedStr) : { text: '', toolCalls: [], thinking: '' };
                streamDebugLog(completionId, 'PARSER_OUTPUT', { feedLen: feedStr.length, textLen: rawText.length, toolCount: toolCalls.length, toolNames: toolCalls.map(t => t.name) });

                if (toolCalls.length) {
                  logStore.updateEntry(logId, entry => {
                    for (const tc of toolCalls) {
                      entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
                    }
                  });

                }
                if (toolCalls.length && process.env.DEBUG) {
                  logDebug('PARSED TOOL CALLS (streaming)', toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })));
                }

                if (rawText) {
                  streamDebugLog(completionId, 'RAW_TEXT', { len: rawText.length, preview: rawText.substring(0, 100) });
                  // Pre-parser cumulative detection: Qwen sometimes sends the full
                  // growing text in each chunk instead of incremental deltas.
                  // Detect this BEFORE accumulating into lastFullContent to prevent
                  // the parser buffer from growing quadratically.
                  if (lastRawContent.length > 0) {
                    const detection = detectCumulativeChunk(rawText, lastRawContent);
                    streamDebugLog(completionId, 'RAW_CUMULATIVE_DETECT', { cumulative: detection.cumulative, deltaLen: detection.delta.length });
                    if (detection.cumulative) {
                      lastRawContent = rawText;
                      lastFullContent += detection.delta;
                    } else if (detection.delta === '') {
                      // Duplicate/retry — skip
                    } else {
                      // Incremental chunk
                      lastRawContent += rawText;
                      lastFullContent += rawText;
                    }
                  } else {
                    lastRawContent = rawText;
                    lastFullContent = rawText;
                  }
                }

                // Apply stateful content filter: returns deltas since last feed() call.
                // The filter maintains internal state and only processes text beyond its
                // confirmed high-water mark. For full filtered text (needed downstream
                // for snapshot diffing), we reconstruct from deltas.
                const { cleanDelta: _cleanDelta, thinkingDelta: _thinkingDelta } = streamFilter.feed(lastFullContent);
                
                // Reconstruct full filtered text for downstream use in snapshot diffing.
                // Note: This is necessary because downstream code uses full text for
                // pendingText/cleanedText calculations and snapshot comparisons.
                const baseFilteredContent = enableContentFiltering
                  ? filterContent(lastFullContent).cleanText
                  : lastFullContent;
                const filteredThinking = enableContentFiltering
                  ? filterContent(lastFullContent).thinking
                  : '';
                const fullFilteredText = stripToolCallArtifacts(baseFilteredContent);

                // Emit parser-captured thinking first (from <think> tags)
                if (parserThinking) {
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ reasoning_content: parserThinking })]
                  });
                }

                // Snapshot-based thinking emission: compare full current thinking
                // against previous snapshot instead of accumulating deltas.
                if (filteredThinking) {
                  const thinkingDelta = getSnapshotDelta(filteredThinking, lastThinkingSnapshot);
                  lastThinkingSnapshot = filteredThinking;
                  if (thinkingDelta) {
                    await writeEvent({
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [makeChoice({ reasoning_content: thinkingDelta })]
                    });
                  }
                }

                const pendingText = (toolCalls.length > 0 && fullFilteredText) ? fullFilteredText : null;
                // Echo filter skipped in streaming — partial lines dodge shingle threshold,
                // creating snapshot mismatch vs flush. Non-streaming path still uses it.
                const cleanedText = pendingText
                  ? cleanThinkTags(pendingText)
                  : (fullFilteredText ? cleanThinkTags(fullFilteredText) : null);

                // Snapshot-based content emission: compare full current filtered text
                // against previous snapshot. This is the key fix — even if the filter
                // reclassifies early content and changes the prefix, we only emit what
                // is genuinely new relative to the previous snapshot.
                if (cleanedText && !pendingText) {
                  const contentDelta = stripStreamingDelta(getSnapshotDelta(cleanedText, lastFilteredSnapshot));
                  lastFilteredSnapshot = cleanedText;
                  if (contentDelta) {
                    if (!amplificationGuardTriggered) {
                      const projectedRatio =
                        (emittedOutputBytes + contentDelta.length) / Math.max(1, rawInputBytes);
                      if (projectedRatio > 3 && emittedOutputBytes > 1000) {
                        amplificationGuardTriggered = true;
                        const ratio = Math.round(projectedRatio * 100) / 100;
                        console.error(
                          `[Chat][AMPLIFICATION GUARD] Triggered! ratio=${ratio}x ` +
                          `rawIn=${rawInputBytes}B emittedOut=${emittedOutputBytes}B ` +
                          `account=${resolvedEmail} model=${body.model}`
                        );
                        logStore.recordAmplificationEvent(
                          logId,
                          ratio,
                          lastRawContent || lastVStrRaw || ''
                        );
                      }
                    }
                    if (amplificationGuardTriggered) {
                      continue;
                    }
                    logStore.addProcessedOutput(logId, contentDelta);
                    emittedOutputBytes += contentDelta.length;
                    await writeEvent({
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [makeChoice({ content: contentDelta })]
                    });
                  }
                }

                let allToolCallsValid = true;
                for (const tc of toolCalls) {
                  // Guard: validate tool call before emitting to client
                  const guard = validateSingleToolCall(tc);
                  if (!guard.ok) {
                    allToolCallsValid = false;
                    console.log(`  [🚫 GUARD REJECT stream] ${tc.name}: ${guard.errors.join(', ')}`);
                    logStore.updateEntry(logId, entry => {
                      entry.errors.push(`Guard rejected streaming tool call "${tc.name}": ${guard.errors.join(', ')}`);
                    });
                    continue; // Skip — don't send malformed tool call to client
                  }
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({
                      tool_calls: [{
                        index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                        id: tc.id,
                        type: 'function',
                        function: {
                          name: tc.name,
                          arguments: JSON.stringify(tc.arguments)
                        }
                      }]
                    })]
                  });
                }

                // Only send text if all tool calls passed guard validation.
                // If any failed, suppress the text to prevent polluting client context.
                if (pendingText && allToolCallsValid && cleanedText) {
              const contentDelta = stripStreamingDelta(getSnapshotDelta(cleanedText, lastFilteredSnapshot));
              lastFilteredSnapshot = cleanedText;
              if (contentDelta) {
                if (!amplificationGuardTriggered) {
                  const projectedRatio =
                    (emittedOutputBytes + contentDelta.length) / Math.max(1, rawInputBytes);
                      if (projectedRatio > 3 && emittedOutputBytes > 1000) {
                        amplificationGuardTriggered = true;
                        const ratio = Math.round(projectedRatio * 100) / 100;
                        console.error(
                          `[Chat][AMPLIFICATION GUARD] Triggered! ratio=${ratio}x ` +
                          `rawIn=${rawInputBytes}B emittedOut=${emittedOutputBytes}B ` +
                          `account=${resolvedEmail} model=${body.model}`
                        );
                        logStore.recordAmplificationEvent(
                          logId,
                          ratio,
                          lastRawContent || lastVStrRaw || ''
                        );
                      }
                    }
                    if (amplificationGuardTriggered) {
                      continue;
                    }
                    logStore.addProcessedOutput(logId, contentDelta);
                    emittedOutputBytes += contentDelta.length;
                    await writeEvent({
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: body.model,
                      choices: [makeChoice({ content: contentDelta })]
                    });
                  }
                }
              }
            }
          } catch (e) {
            console.error('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
          }
        }
      }

      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: upstreamError.message })]
        });
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({}, 'stop')]
        });
        await streamWriter.write('data: [DONE]\n\n');
        return;
      }

      // Flush tool parser
      const { text: remainingText, toolCalls: remainingToolCalls, thinking: remainingThinking } = toolParser.flush();
      if (process.env.DEBUG) {
        if (remainingText) logDebug('STREAMING FLUSH TEXT', remainingText.length > 500 ? remainingText.substring(0, 500) : remainingText);
        if (remainingToolCalls.length) logDebug('STREAMING FLUSH TOOL CALLS', remainingToolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })));
        logDebug('STREAMING FINISH REASON', toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop');
      }
      if (remainingThinking) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ reasoning_content: remainingThinking })]
        });
      }
      // Flush remaining text via snapshot diffing — avoid double-emitting content
      // already streamed. Compare the final full filtered text against the last
      // snapshot to emit only genuinely new content.
      if (remainingText) {
        lastFullContent += remainingText;
      }
      // Flush the streaming filter to capture any remaining content
      const { cleanDelta: _flushCleanDelta, thinkingDelta: _flushThinkingDelta } = streamFilter.flush();
      const { cleanText: flushBase, thinking: flushThinking } = (enableContentFiltering && lastFullContent)
        ? filterContent(lastFullContent)
        : { cleanText: lastFullContent || '', thinking: '' };
      const flushFiltered = stripToolCallArtifacts(flushBase);
      const flushCleaned = cleanThinkTags(flushFiltered);

      if (flushThinking) {
        const thinkDelta = getSnapshotDelta(flushThinking, lastThinkingSnapshot);
        if (thinkDelta) {
          lastThinkingSnapshot = flushThinking;
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ reasoning_content: thinkDelta })]
          });
        }
      }
      if (flushCleaned) {
        const contentDelta = getSnapshotDelta(flushCleaned, lastFilteredSnapshot);
        if (contentDelta) {
          // Amplification guard on flush emission
          if (!amplificationGuardTriggered) {
            const projectedRatio =
              (emittedOutputBytes + contentDelta.length) / Math.max(1, rawInputBytes);
            if (projectedRatio > 3 && emittedOutputBytes > 1000) {
              amplificationGuardTriggered = true;
              const ratio = Math.round(projectedRatio * 100) / 100;
              console.error(
                `[Chat][AMPLIFICATION GUARD] Triggered on flush! ratio=${ratio}x ` +
                `rawIn=${rawInputBytes}B emittedOut=${emittedOutputBytes}B ` +
                `account=${resolvedEmail} model=${body.model}`
              );
              logStore.recordAmplificationEvent(
                logId,
                ratio,
                lastRawContent || lastVStrRaw || ''
              );
            }
          }
          if (amplificationGuardTriggered) {
            lastFilteredSnapshot = flushCleaned;
          } else {
            lastFilteredSnapshot = flushCleaned;
            const ct = stripStreamingDelta(contentDelta).replace(/[\n\s]*$/, '');
            if (ct) {
              logStore.addProcessedOutput(logId, ct);
              emittedOutputBytes += ct.length;
              await writeEvent({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [makeChoice({ content: ct })]
              });
            }
          }
        }
      }
      for (const tc of remainingToolCalls) {
        // Guard: validate tool call before emitting to client
        const guard = validateSingleToolCall(tc);
        if (!guard.ok) {
          console.log(`  [🚫 GUARD REJECT stream-flush] ${tc.name}: ${guard.errors.join(', ')}`);
          logStore.updateEntry(logId, entry => {
            entry.errors.push(`Guard rejected streaming flush tool call "${tc.name}": ${guard.errors.join(', ')}`);
          });
          continue;
        }
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [{
              index: toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            }]
          })]
        });
      }
      // Send finish reason
      const streamReasoningTokensEstimate = reasoningBuffer ? Math.ceil(reasoningBuffer.length / 4) : 0;
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: { reasoning_tokens: streamReasoningTokensEstimate },
        prompt_tokens_details: { cached_tokens: 0 }
      };
  
      const finalFinishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';
  
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        system_fingerprint: 'fp_qwen_gate',
        service_tier: 'default',
        choices: [makeChoice({}, finalFinishReason)],
        ...(body.stream_options?.include_usage ? {} : { usage })
      });

      if (body.stream_options?.include_usage) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          system_fingerprint: 'fp_qwen_gate',
          service_tier: 'default',
          choices: [],
          usage
        });
      }
      await streamWriter.write('data: [DONE]\n\n');

      const finalRatio =
        rawInputBytes > 0 ? Math.round((emittedOutputBytes / rawInputBytes) * 100) / 100 : 0;
      if (finalRatio > 2) {
        console.warn(
          `[Chat] High amplification ratio: ${finalRatio}x ` +
          `(rawIn=${rawInputBytes}B, out=${emittedOutputBytes}B) account=${resolvedEmail}`
        );
        logStore.updateEntry(logId, (entry) => {
          entry.amplificationRatio = finalRatio;
        });
      }

      // Capture cleanup refs for deferred background cleanup.
      // DO NOT do anything else here — callback must return ASAP so Hono
      // flushes [DONE] and closes the HTTP response. Client disconnects immediately.
      const _cleanupReader = reader;
      const _cleanupInterval = heartbeatInterval;
      const _cleanupChatId = session.chatId;
      const _cleanupParentId = nextParentId;
      const _cleanupHeaders = sessionHeaders;
      const _cleanupEmail = resolvedEmail;

      // 200ms delay ensures the HTTP response is fully flushed and TCP FIN is sent
      // before any background work competes for event loop time.
      streamReleased = true;
      setTimeout(() => {
        clearInterval(_cleanupInterval);
        try { _cleanupReader.cancel(); } catch {
          // intentional: cancel may fail if reader already closed, continue cleanup
        }
        try { _cleanupReader.releaseLock(); } catch {
          // intentional: releaseLock may fail if already released, continue cleanup
        }
        sessionPool.release(_cleanupChatId, _cleanupParentId, _cleanupHeaders, _cleanupEmail);
        // Persist raw vs processed output for debugging
        const entry = logStore.getRecent(1).find(e => e.id === logId);
        if (entry) logStore.persistRequest(entry);
      }, 200);

      } finally {
        clearInterval(heartbeatInterval);
        if (!streamReleased && streamReader) {
          try { streamReader.cancel(); } catch {
            // intentional: cancel may fail if reader already closed, continue cleanup
          }
          try { streamReader.releaseLock(); } catch {
            // intentional: releaseLock may fail if already released, continue cleanup
          }
          sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
          const entry = logStore.getRecent(1).find(e => e.id === logId);
          if (entry) logStore.persistRequest(entry);
        }
      }
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    logStore.addError(logId, err.message || String(err));
    const status = err.upstreamStatus || 500;
    return c.json({ error: { message: err.message } }, status);
  }
}
