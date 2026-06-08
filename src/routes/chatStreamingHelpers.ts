import {
  detectCumulativeChunk,
  getSnapshotDelta,
  cleanThinkTags,
  extractDeltaContent,
  type AmplificationGuardState,
} from "./chatHelpers.ts";
import { validateSingleToolCall } from '../tools/guard.ts';
import type { ParsedToolCall } from '../types/openai.ts';
import { logStore } from '../services/logStore.ts';
import { parseXmlToolCalls, cleanTextOfXmlArtifacts, xmlToolCallToParsed } from '../tools/xmlToolParser.ts';
import { logQwenSSE } from '../services/qwenLogger.ts';
import { filterContent } from '../utils/contentFilter.ts';

import {
  writeReasoningEvent,
  writeContentDelta,
  writeToolCallEvent,
  writeDeferredThinking,
} from './writeHelpers.ts';

// ── Constants ──────────────────────────────────────────────────────

/**
 * Matches self-closing thinking/tool tags (newlines/spaces around tags).
 * Performance: extracted to module-level const to avoid recompilation on each chunk.
 */
const SELF_CLOSING_TAG_PATTERN = /^[\n\s]*<\/?(?:think|thinking|thought|tool_call|tool_use|function_call)[\s>]*[\n\s]*$/;

// ── Tool call handling ─────────────────────────────────────────────

/**
 * Log tool calls to logStore, validate each, and write SSE events.
 * Returns true if all tool calls passed validation.
 */
const MAX_TOOL_CALLS_PER_TURN = 8;

export async function handleToolCalls(
  toolCalls: any[],
  logId: string,
  streamWriter: any,
  completionId: string,
  model: string,
  emittedToolCallCount: number,
): Promise<boolean> {
  if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
    console.warn(`  [🛑 TOOL LIMIT] Truncating ${toolCalls.length} tool calls to first ${MAX_TOOL_CALLS_PER_TURN}`);
    logStore.updateEntry(logId, entry => {
      entry.errors.push(
        `Note: Only the first ${MAX_TOOL_CALLS_PER_TURN} tool calls will be executed. Remaining ${toolCalls.length - MAX_TOOL_CALLS_PER_TURN} calls were dropped.`,
      );
    });
    toolCalls = toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
  }

  logStore.updateEntry(logId, entry => {
    for (const tc of toolCalls) {
      entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
    }
  });

  let allValid = true;
  const baseIndex = emittedToolCallCount - toolCalls.length;
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const guard = validateSingleToolCall(tc);
    if (!guard.ok) {
      allValid = false;
      logStore.updateEntry(logId, entry => {
        entry.errors.push(`Guard rejected streaming tool call "${tc.name}": ${guard.errors.join(', ')}`);
      });
      continue;
    }
    await writeToolCallEvent(streamWriter, completionId, model, tc, baseIndex + i, logStore, logId);
  }
  return allValid;
}

// ── Local MCP tool call extraction (from Qwen Studio local_tool phase) ──

/**
 * Extract tool calls from SSE data containing `extra.local_mcp` in the delta.
 * Qwen Studio sends tool calls in this format during the `local_tool` phase:
 *
 * ```json
 * {"choices": [{"delta": {"role": "assistant", "content": "", "phase": "local_tool",
 *   "status": "finished",
 *   "extra": {"local_mcp": {"Qwen Core": [{"tool_name": "bash", "params": {"command": "ls -la /tmp"}}]}}}}]}
 * ```
 *
 * @param sseData - Parsed SSE data chunk
 * @param clientName - MCP server key (defaults to first key in local_mcp object)
 * @returns Array of ParsedToolCall with UUID call IDs
 */
export function extractLocalMcpToolCalls(
  sseData: any,
  clientName?: string,
): ParsedToolCall[] {
  const localMcp = sseData?.choices?.[0]?.delta?.extra?.local_mcp;
  if (!localMcp) return [];

  const resolvedClient = clientName ?? Object.keys(localMcp)[0] ?? "qwengate";

  const serverTools = localMcp[resolvedClient];
  if (!Array.isArray(serverTools)) return [];

  const toolCalls: ParsedToolCall[] = [];
  for (const tool of serverTools) {
    if (tool?.tool_name && tool?.params !== undefined) {
      toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name: tool.tool_name,
        arguments: tool.params,
      });
    }
  }
  return toolCalls;
}

// ── Per-chunk stream processing ────────────────────────────────────

export interface StreamProcessingState {
  targetResponseId: string | null;
  nextParentId: string | null;
  completionTokens: number;
  promptTokens: number;
  currentThoughtIndex: number;
  reasoningBuffer: string;
  deferredThinkingChunks: string[];
  lastFullContent: string;
  lastRawContent: string;
  lastFilteredSnapshot: string;
  lastThinkingSnapshot: string;
  lastVStrRaw: string;
}

export interface StreamProcessingCtx {
  streamWriter: any;
  completionId: string;
  model: string;
  emittedToolCallCount: number;
  enableContentFiltering: boolean;
  cleanOutput: boolean;
  logId: string;
  resolvedEmail: string;
  ampState: AmplificationGuardState;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  streamReader: ReadableStreamDefaultReader<Uint8Array> | null;
  qwenAbortController: AbortController;
  qwenLogFile?: string;
  sseEventCount?: number;
}

export type ProcessStreamResult = 'continue' | 'break_stream';

/**
 * Process a single parsed SSE data chunk from the stream.
 * Mutates `state` in place and returns a directive:
 *   - 'continue'      → normal processing, keep iterating
 *   - 'break_stream'  → stream finished (break out of loops)
 */
export async function processStreamData(
  data: any,
  state: StreamProcessingState,
  ctx: StreamProcessingCtx,
): Promise<ProcessStreamResult> {
  const {
    streamWriter, completionId, model, enableContentFiltering,
    logId, resolvedEmail, ampState, reader: _reader, streamReader: _streamReader, qwenAbortController: _qwenAbortController,
  } = ctx;

    if (data.choices?.[0]?.delta?.status === 'finished') {
    const deltaPhase = data.choices[0].delta.phase;
    if (deltaPhase !== 'thinking_summary') {
      // Extract and emit local MCP tool calls before breaking the stream
      if (deltaPhase === 'local_tool') {
        const localToolCalls = extractLocalMcpToolCalls(data);
        logStore.updateEntry(logId, entry => {
          for (const tc of localToolCalls) {
            entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
          }
        });
        for (let i = 0; i < localToolCalls.length; i++) {
          await writeToolCallEvent(streamWriter, completionId, model, localToolCalls[i], i, logStore, logId);
        }
        if (ctx.qwenLogFile && localToolCalls.length > 0) {
          logQwenSSE(ctx.qwenLogFile, ctx.sseEventCount || 0, localToolCalls.length, localToolCalls);
        }
      }
      return 'break_stream';
    }
  }

  // Track SSE events for logging
  ctx.sseEventCount = (ctx.sseEventCount || 0) + 1;

  if (data['response.created']?.response_id) {
    if (!state.targetResponseId) state.targetResponseId = data['response.created'].response_id;
    state.nextParentId = data['response.created'].response_id;
  } else if (data.response_id && !state.targetResponseId) {
    state.targetResponseId = data.response_id;
    state.nextParentId = data.response_id;
  }

  if (data.usage) {
    if (data.usage.output_tokens) state.completionTokens = data.usage.output_tokens;
    if (data.usage.input_tokens) state.promptTokens = data.usage.input_tokens;
  }

  const deltaResult = extractDeltaContent(data, state.targetResponseId, state.currentThoughtIndex, state.reasoningBuffer);
  const { vStr, foundStr, isThinkingChunk } = deltaResult;
  state.currentThoughtIndex = deltaResult.currentThoughtIndex;

  if (!foundStr || vStr === '') return 'continue';
  if (vStr === 'FINISHED') return 'continue';

  if (isThinkingChunk) {
    state.reasoningBuffer += vStr;
    state.deferredThinkingChunks.push(vStr);
    return 'continue';
  }

  if (SELF_CLOSING_TAG_PATTERN.test(vStr)) {
    return 'continue';
  }

  logStore.addRawChunk(logId, vStr);

  // Compute incremental delta for text content tracking
  let rawText = vStr;
  if (state.lastVStrRaw.length > 0) {
    const cumulativeDetection = detectCumulativeChunk(vStr, state.lastVStrRaw);
    if (cumulativeDetection.cumulative) {
      rawText = cumulativeDetection.delta;
      state.lastVStrRaw = vStr;
    } else if (!cumulativeDetection.delta) {
      rawText = '';
    } else {
      state.lastVStrRaw += vStr;
    }
  } else {
    state.lastVStrRaw = vStr;
  }

  if (rawText) {
    state.lastRawContent += rawText;
    state.lastFullContent += rawText;
  }

  // Keep state.lastFullContent raw so partial <function=...> survives for the next chunk
  const { toolCalls: xmlToolCalls } = parseXmlToolCalls(state.lastFullContent);
  if (xmlToolCalls.length > 0) {
    logStore.updateEntry(logId, entry => {
      for (const tc of xmlToolCalls) {
        entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.parameters) });
      }
    });
    for (const [i, tc] of xmlToolCalls.entries()) {
      const parsed = xmlToolCallToParsed(tc, i);
      await writeToolCallEvent(streamWriter, completionId, model, parsed, i, logStore, logId);
    }
  }

  const contentForUser = cleanTextOfXmlArtifacts(state.lastFullContent).cleanedText;
  const filteredResult = enableContentFiltering
    ? filterContent(contentForUser)
    : { cleanText: contentForUser, thinking: '' };
  const baseFilteredContent = filteredResult.cleanText;
  const filteredThinking = filteredResult.thinking;

  if (state.deferredThinkingChunks.length > 0) {
    await writeDeferredThinking(streamWriter, completionId, model, state.deferredThinkingChunks);
    state.deferredThinkingChunks = [];
  }

      if (filteredThinking) {
        const thinkingDelta = getSnapshotDelta(filteredThinking, state.lastThinkingSnapshot);
        state.lastThinkingSnapshot = filteredThinking;
        if (thinkingDelta) {
          await writeReasoningEvent(streamWriter, completionId, model, thinkingDelta);
        }
      }

  const cleanedText = baseFilteredContent
    ? cleanThinkTags(baseFilteredContent)
    : null;

  if (cleanedText) {
    // Text-only content (no tool calls): write content delta to SSE + logStore
    const contentDelta = getSnapshotDelta(cleanedText, state.lastFilteredSnapshot);
    state.lastFilteredSnapshot = cleanedText;
    if (contentDelta) {
      await writeContentDelta(streamWriter, completionId, model, contentDelta, ampState, logId, resolvedEmail, state.lastRawContent, state.lastVStrRaw, logStore);
    }
  }

  return 'continue';
}

export { checkFinalAmplification, scheduleCleanup, cleanupImmediately } from "./cleanupHelpers.ts";
export { runStreamLoop, handlePostStreamCompletion } from "./streamLoop.ts";
export type { StreamLoopResult } from "./streamLoop.ts";
