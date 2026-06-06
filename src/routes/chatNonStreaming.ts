import { Context } from 'hono';
import type { OpenAIRequest } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { detectParallelToolLoop } from '../tools/guard.ts';
import { filterContent, stripToolCallArtifacts } from '../utils/contentFilter.ts';
import { ToolResultEchoFilter } from './pipeline/ToolResultEchoFilter.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { logStore } from '../services/logStore.ts';
import {
  logDebug,
  commonPrefixLen,
  detectCumulativeChunk,
  parseQwenErrorPayload,
  processToolCallsThroughGuard,
  ToolSpamGuard,
  pendingCorrections,
} from './chatHelpers.ts';
import type { ParsedToolCall } from '../tools/types.ts';

const MAX_TOOL_CALLS_PER_TURN = 15;

export interface NonStreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  finalPrompt: string;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  toolResultContents: string[];
}

interface StreamProcessorState {
  reader: ReadableStreamDefaultReader;
  decoder: TextDecoder;
  currentThoughtIndex: number;
  reasoningBuffer: string;
  lastFullContent: string;
  targetResponseId: string | null;
  toolParser: StreamingToolParser;
  toolCallsOut: any[];
  correctionPrompts: string[];
  toolSpamGuard: ToolSpamGuard;
  buffer: string;
  completionTokens: number;
  promptTokens: number;
  nextParentId: string | null;
}

function buildQwenRequest(ctx: NonStreamingContext): StreamProcessorState {
  const reader = ctx.stream.getReader();
  const toolParser = new StreamingToolParser();
  if (!ctx.toolCalling) toolParser.passThrough = true;
  return {
    reader,
    decoder: new TextDecoder(),
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    lastFullContent: '',
    targetResponseId: null,
    toolParser,
    toolCallsOut: [],
    correctionPrompts: [],
    toolSpamGuard: new ToolSpamGuard(),
    buffer: '',
    completionTokens: 0,
    promptTokens: Math.ceil(ctx.finalPrompt.length / 3.5),
    nextParentId: ctx.initialParentId,
  };
}

function processThinkingDelta(delta: any, state: StreamProcessorState): void {
  const thoughts = delta.extra?.summary_thought?.content;
  if (!thoughts) return;

  const rawNew = thoughts.slice(state.currentThoughtIndex).join('\n');
  if (!rawNew) return;

  const commonLen = commonPrefixLen(rawNew, state.reasoningBuffer);
  const vStr = rawNew.substring(commonLen);
  if (!vStr) return;

  state.currentThoughtIndex = thoughts.length;
  state.reasoningBuffer += vStr;
}

function processAnswerDelta(delta: any, state: StreamProcessorState, ctx: NonStreamingContext): void {
  if (delta.content === undefined) return;
  const vStr = delta.content || '';
  if (!vStr || vStr === 'FINISHED') return;

  logStore.addRawChunk(ctx.logId, vStr);
  if (vStr.includes('"name"')) {
    logDebug('QWEN RAW CHUNK (non-streaming)', vStr);
  }

  const { toolCalls, thinking, text: parserText } = state.toolParser.feed(vStr);
  if (thinking) state.reasoningBuffer += thinking;

  if (parserText) {
    if (state.lastFullContent.length > 0) {
      const detection = detectCumulativeChunk(parserText, state.lastFullContent);
      state.lastFullContent = detection.cumulative ? parserText : state.lastFullContent + parserText;
    } else {
      state.lastFullContent = parserText;
    }
  }

  processToolCallsThroughGuard(toolCalls, state.toolCallsOut, {
    logId: ctx.logId,
    toolSpamGuard: state.toolSpamGuard,
    correctionPrompts: state.correctionPrompts,
    maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
    logParsed: true,
  });
}

function parseQwenResponse(line: string, state: StreamProcessorState, ctx: NonStreamingContext): void {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return;

  const dataStr = trimmed.slice(6);
  if (dataStr === '[DONE]') return;

  let chunk: any;
  try {
    chunk = JSON.parse(dataStr);
  } catch (e) {
    console.error('[Chat] Non-streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
    return;
  }

  if (chunk['response.created']?.response_id) {
    if (!state.targetResponseId) state.targetResponseId = chunk['response.created'].response_id;
    state.nextParentId = chunk['response.created'].response_id;
  } else if (chunk.response_id && !state.targetResponseId) {
    state.targetResponseId = chunk.response_id;
    state.nextParentId = chunk.response_id;
  }

  if (chunk.usage) {
    if (chunk.usage.output_tokens) state.completionTokens = chunk.usage.output_tokens;
    if (chunk.usage.input_tokens) state.promptTokens = chunk.usage.input_tokens;
  }

  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return;
  if (state.targetResponseId !== null && chunk.response_id !== state.targetResponseId) return;

  if (delta.phase === 'thinking_summary') {
    processThinkingDelta(delta, state);
  } else if (delta.phase === 'answer') {
    processAnswerDelta(delta, state, ctx);
  }
}

function flushAndDetectLoops(state: StreamProcessorState, logId: string): void {
  const { text, toolCalls, thinking } = state.toolParser.flush();
  if (text) state.lastFullContent += text;
  if (thinking) state.reasoningBuffer += thinking;

  processToolCallsThroughGuard(toolCalls, state.toolCallsOut, {
    logId,
    toolSpamGuard: state.toolSpamGuard,
    correctionPrompts: state.correctionPrompts,
    maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
    label: 'flush',
  });

  if (state.toolCallsOut.length < 3) return;

  const parsedForLoopCheck: ParsedToolCall[] = state.toolCallsOut.map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
  }));
  const loopCheck = detectParallelToolLoop(parsedForLoopCheck);
  if (!loopCheck.ok) {
    console.warn(`  [🔄 PARALLEL LOOP] ${loopCheck.errors[0]}`);
    state.correctionPrompts.push(loopCheck.correctionPrompt);
    logStore.updateEntry(logId, entry => {
      entry.errors.push(`Parallel loop: ${loopCheck.errors[0]}`);
    });
  }
}

function buildResponseFromState(state: StreamProcessorState, ctx: NonStreamingContext): Response {
  const { c, logId, completionId, body, session, cleanOutput, toolResultContents } = ctx;

  const reasoningTokensEstimate = state.reasoningBuffer ? Math.ceil(state.reasoningBuffer.length / 4) : 0;
  const usage = {
    prompt_tokens: state.promptTokens,
    completion_tokens: state.completionTokens,
    total_tokens: state.promptTokens + state.completionTokens,
    completion_tokens_details: { reasoning_tokens: reasoningTokensEstimate },
    prompt_tokens_details: { cached_tokens: 0 },
  };

  const { cleanText: baseFilteredContent, thinking: filteredReasoning } = cleanOutput
    ? filterContent(state.lastFullContent)
    : { cleanText: state.lastFullContent, thinking: '' };
  if (filteredReasoning) {
    state.reasoningBuffer = state.reasoningBuffer
      ? state.reasoningBuffer + '\n' + filteredReasoning
      : filteredReasoning;
  }

  const toolEchoFilter = new ToolResultEchoFilter(toolResultContents);
  const echoFiltered = toolEchoFilter.filterText(baseFilteredContent);
  const echoRatio = toolEchoFilter.getEchoRatio(baseFilteredContent);
  if (echoRatio > 0.3 && baseFilteredContent.length > 0) {
    const echoWarning = `[ECHO WARNING] ${Math.round(echoRatio * 100)}% of output was tool result echoes — suppressing. Review system prompt anti-echo directives.`;
    console.warn(`  [${echoWarning}]`);
    logStore.addError(logId, echoWarning);
    state.correctionPrompts.push(echoWarning);
  }

  const filteredContent = stripToolCallArtifacts(echoFiltered);

  const message: any = { role: 'assistant', content: state.toolCallsOut.length ? null : filteredContent };
  if (state.reasoningBuffer) message.reasoning_content = state.reasoningBuffer;
  if (state.toolCallsOut.length) {
    state.toolCallsOut.forEach((tc, idx) => tc.index = idx);
    message.tool_calls = state.toolCallsOut;
  }

  logStore.updateEntry(logId, entry => {
    const now = Date.now();
    const startedAt = new Date(entry.timestamp).getTime();
    if (startedAt) entry.latency_ms = now - startedAt;
    entry.finalResponse = {
      finishReason: state.toolCallsOut.length ? 'tool_calls' : 'stop',
      toolCallCount: state.toolCallsOut.length,
      contentPreview: state.lastFullContent.length > 500
        ? state.lastFullContent.substring(0, 500) + '...'
        : state.lastFullContent,
    };
    entry.remainingText = state.lastFullContent;
    entry.processedApiOutput = filteredContent;
    if (state.correctionPrompts.length > 0) entry.errors.push(...state.correctionPrompts);
  });

  if (state.correctionPrompts.length > 0) {
    pendingCorrections.set(session.chatId, [...state.correctionPrompts]);
  }

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
      finish_reason: state.toolCallsOut.length ? 'tool_calls' : 'stop',
    }],
    usage,
  });
}

async function processContentChunks(state: StreamProcessorState, ctx: NonStreamingContext): Promise<Response> {
  const { c, logId } = ctx;

  const upstreamError = parseQwenErrorPayload(state.buffer);
  if (upstreamError) {
    logStore.finalizeRequest(logId);
    return c.json({ error: { message: upstreamError.message } }, upstreamError.status);
  }

  flushAndDetectLoops(state, logId);
  const response = buildResponseFromState(state, ctx);
  logStore.finalizeRequest(logId);
  return response;
}

export async function handleNonStreamingRequest(ctx: NonStreamingContext): Promise<Response> {
  const { session, sessionHeaders, resolvedEmail } = ctx;
  const state = buildQwenRequest(ctx);
  let nonStreamReleased = false;

  try {
    while (true) {
      const { done, value } = await state.reader.read();
      if (done) break;

      state.buffer += state.decoder.decode(value, { stream: true });
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || '';

      for (const line of lines) {
        parseQwenResponse(line, state, ctx);
      }
    }

    nonStreamReleased = true;
    sessionPool.release(session.chatId, state.nextParentId, sessionHeaders, resolvedEmail);
    return processContentChunks(state, ctx);
  } finally {
    try { state.reader.cancel(); } catch { /* reader already cancelled */ }
    try { state.reader.releaseLock(); } catch { /* reader already cancelled */ }
    if (!nonStreamReleased) {
      sessionPool.release(session.chatId, state.nextParentId, sessionHeaders, resolvedEmail);
    }
  }
}
