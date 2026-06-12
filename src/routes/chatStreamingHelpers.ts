import {
  detectCumulativeChunk,
  getSnapshotDelta,
  cleanThinkTags,
  extractDeltaContent,
  type AmplificationGuardState,
} from "./chatHelpers.ts";
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
const SELF_CLOSING_TAG_PATTERN = /^[\n\s]*<\/?(?:think(?:ing)?|thought)[\s>]*[\n\s]*$/;

// ── Local MCP tool call extraction (from Qwen Studio local_tool phase) ──

/**
 * Extract tool calls from SSE data containing `extra.local_mcp` in the delta.
 * Qwen Studio sends tool calls in this format during the `local_tool` phase:
 *
 * ```json
 * {"choices": [{"delta": {"role": "assistant", "content": "", "phase": "local_tool",
 *   "status": "finished",
 *   "extra": {"local_mcp": {"★": [{"tool_name": "★-bash", "params": {"command": "ls -la /tmp"}}]}}}}]}
 * ```
 *
 * @param sseData - Parsed SSE data chunk
 * @returns Array of ParsedToolCall with UUID call IDs
 */
export function extractLocalMcpToolCalls(
  sseData: any,
): ParsedToolCall[] {
  const localMcp = sseData?.choices?.[0]?.delta?.extra?.local_mcp;
  if (!localMcp) return [];

  const serverTools = localMcp["★"];
  if (!Array.isArray(serverTools)) return [];

  const toolCalls: ParsedToolCall[] = [];
  for (const tool of serverTools) {
    if (tool?.tool_name && tool?.params !== undefined) {
      const rawName = tool.tool_name;
      const name = rawName.startsWith("★-") ? rawName.slice(2) : rawName;
      toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name,
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
  loggedToolCalls: Set<string>;
  lastParsePosition: number;
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
 * Shared content filter pipeline standardizing the order:
 * cleanTextOfXmlArtifacts → filterContent → cleanThinkTags.
 * Used in both per-chunk (processStreamData) and flush (handlePostStreamCompletion) paths.
 */
export function filterContentPipeline(
  text: string,
  enableContentFiltering: boolean,
): { cleanText: string | null; thinking: string } {
  if (!text) return { cleanText: null, thinking: '' };
  const { cleanedText: stripped } = cleanTextOfXmlArtifacts(text);
  if (!enableContentFiltering) {
    const cleaned = cleanThinkTags(stripped);
    return { cleanText: cleaned || null, thinking: '' };
  }
  const filtered = filterContent(stripped);
  const cleaned = cleanThinkTags(filtered.cleanText);
  return {
    cleanText: cleaned || null,
    thinking: filtered.thinking || '',
  };
}

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
        const newToolCalls = localToolCalls.filter(tc => {
          const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
          if (state.loggedToolCalls.has(key)) return false;
          state.loggedToolCalls.add(key);
          return true;
        });
        
        if (newToolCalls.length > 0) {
          logStore.updateEntry(logId, entry => {
            for (const tc of newToolCalls) {
              entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
            }
          });
          for (let i = 0; i < newToolCalls.length; i++) {
            await writeToolCallEvent(streamWriter, completionId, model, newToolCalls[i], i);
          }
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
    if (state.reasoningBuffer.length < 20000) state.reasoningBuffer += vStr;
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
      if (state.lastVStrRaw.length > 100000) state.lastVStrRaw = state.lastVStrRaw.slice(-100000);
    }
  } else {
    state.lastVStrRaw = vStr;
  }

  if (rawText) {
    state.lastRawContent += rawText;
    state.lastFullContent += rawText;
  }

  // Keep state.lastFullContent raw so partial <function=...> survives for the next chunk
  const newToolCallContent = state.lastFullContent.slice(state.lastParsePosition);
  const { toolCalls: xmlToolCalls } = parseXmlToolCalls(newToolCallContent);
  if (xmlToolCalls.length > 0) {
    const newToolCalls = xmlToolCalls.filter(tc => {
      const key = `${tc.name}:${JSON.stringify(tc.parameters)}`;
      if (state.loggedToolCalls.has(key)) return false;
      state.loggedToolCalls.add(key);
      return true;
    });
    
    if (newToolCalls.length > 0) {
      logStore.updateEntry(logId, entry => {
        for (const tc of newToolCalls) {
          entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.parameters) });
        }
      });
    }
    
    for (const [i, tc] of newToolCalls.entries()) {
      const parsed = xmlToolCallToParsed(tc, ctx.emittedToolCallCount + i);
      await writeToolCallEvent(streamWriter, completionId, model, parsed, ctx.emittedToolCallCount + i);
    }
    ctx.emittedToolCallCount += newToolCalls.length;
  }

  // Truncate lastFullContent to prevent unbounded growth (M-10)
  // Use a generous limit (100000 chars ≈ 25000 tokens) so the content delta
  // pipeline always has stable, growing input for getSnapshotDelta to diff.
  // When truncation IS triggered, also reset the snapshot trackers so
  // filterContentPipeline rebuilds from scratch for the next chunk.
  if (state.lastFullContent.length > 100000) {
    state.lastFullContent = state.lastFullContent.slice(-80000);
    state.lastFilteredSnapshot = '';
    state.lastThinkingSnapshot = '';
    state.lastParsePosition = 0;
  }

  state.lastParsePosition = state.lastFullContent.length;

  if (state.loggedToolCalls.size > 500) state.loggedToolCalls.clear();

  // Performance: only run the expensive content filter pipeline when there
  // is genuinely new raw content since the last pipeline invocation. This
  // avoids O(n²) work (regex chains on the full 100KB buffer) on empty
  // or thinking-only chunks that don't add answer text.
  if (!rawText) return 'continue';

  const pipelineResult = filterContentPipeline(state.lastFullContent, enableContentFiltering);
  const cleanedText = pipelineResult.cleanText;
  const filteredThinking = pipelineResult.thinking;

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
