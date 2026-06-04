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
import { config } from '../services/configService.ts';
import type { ParsedToolCall } from '../tools/types.ts';

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

export async function handleNonStreamingRequest(ctx: NonStreamingContext): Promise<Response> {
  const { c, logId, completionId, body, finalPrompt, session, stream, resolvedEmail, sessionHeaders, toolCalling, cleanOutput, toolResultContents } = ctx;
  let nextParentId = ctx.initialParentId;

  const reader = stream.getReader();
  let nonStreamReleased = false;
  try {
    const decoder = new TextDecoder();

    let currentThoughtIndex = 0;
    let reasoningBuffer = '';
    let lastFullContent = '';
    let targetResponseId: string | null = null;
    const toolParser = new StreamingToolParser();
    if (!toolCalling) toolParser.passThrough = true;
    const toolCallsOut: any[] = [];
    const correctionPrompts: string[] = [];
    const toolSpamGuard = new ToolSpamGuard();
    const MAX_TOOL_CALLS_PER_TURN = 15;

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
              logStore.addRawChunk(logId, vStr);
              if ((vStr.includes('"name"'))) {
                logDebug('QWEN RAW CHUNK (non-streaming)', vStr);
              }
              const { toolCalls, thinking, text: parserText } = toolParser.feed(vStr);
              if (thinking) {
                reasoningBuffer += thinking;
              }
              if (parserText) {
                if (lastFullContent.length > 0) {
                  const detection = detectCumulativeChunk(parserText, lastFullContent);
                  if (detection.cumulative) {
                    lastFullContent = parserText;
                  } else if (detection.delta === '') {
                  } else {
                    lastFullContent += parserText;
                  }
                } else {
                  lastFullContent = parserText;
                }
              }
              processToolCallsThroughGuard(toolCalls, toolCallsOut, {
                logId,
                toolSpamGuard,
                correctionPrompts,
                maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
                logParsed: true,
              });
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
    processToolCallsThroughGuard(remainingToolCalls, toolCallsOut, {
      logId,
      toolSpamGuard,
      correctionPrompts,
      maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
      label: 'flush',
    });

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
    const { cleanText: baseFilteredContent, thinking: filteredReasoning } = cleanOutput
      ? filterContent(lastFullContent)
      : { cleanText: lastFullContent, thinking: '' };
    if (filteredReasoning) {
      reasoningBuffer = reasoningBuffer ? reasoningBuffer + '\n' + filteredReasoning : filteredReasoning;
    }
    const toolEchoFilter = new ToolResultEchoFilter(toolResultContents);
    const echoFiltered = toolEchoFilter.filterText(baseFilteredContent);
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
      const now = Date.now();
      const startedAt = new Date(entry.timestamp).getTime();
      if (startedAt) entry.latency_ms = now - startedAt;
      entry.finalResponse = {
        finishReason: toolCallsOut.length ? 'tool_calls' : 'stop',
        toolCallCount: toolCallsOut.length,
        contentPreview: lastFullContent.length > 500 ? lastFullContent.substring(0, 500) + '...' : lastFullContent,
      };
      entry.remainingText = lastFullContent;
      entry.processedApiOutput = filteredContent;
      if (correctionPrompts.length > 0) entry.errors.push(...correctionPrompts);
    });

    if (false) {
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
    }
    try { reader.releaseLock(); } catch {
    }
    if (!nonStreamReleased) {
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
    }
  }
}
