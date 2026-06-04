import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import type { OpenAIRequest } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { validateSingleToolCall } from '../tools/guard.ts';
import { filterContent, stripToolCallArtifacts, stripStreamingDelta } from '../utils/contentFilter.ts';
import { StreamingContentFilter } from './pipeline/StreamingContentFilter.ts';
import { StreamingEchoFilter } from './pipeline/StreamingEchoFilter.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { logStore } from '../services/logStore.ts';
import {
  logDebug,
  streamDebugLog,
  detectCumulativeChunk,
  getSnapshotDelta,
  cleanThinkTags,
  parseQwenErrorPayload,
  extractDeltaContent,
  checkAmplificationGuard,
  pendingCorrections,
  type AmplificationGuardState,
} from './chatHelpers.ts';
import { config } from '../services/configService.ts';

export interface StreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  finalPrompt: string;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  qwenAbortController: AbortController;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  toolResultContents: string[];
}

export async function handleStreamingRequest(ctx: StreamingContext): Promise<Response> {
  const { c, logId, completionId, body, finalPrompt, session, stream, qwenAbortController, resolvedEmail, sessionHeaders, toolCalling, cleanOutput, toolResultContents } = ctx;
  let nextParentId = ctx.initialParentId;

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
    await streamWriter.write(': heartbeat\n\n');

    heartbeatInterval = setInterval(async () => {
      try {
        await streamWriter.write(': keep-alive\n\n');
      } catch (_e) {
        clearInterval(heartbeatInterval);
        streamDone = true;
      }
    }, 15000);
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
    let reader: ReadableStreamDefaultReader<Uint8Array> = streamReader;
    const decoder = new TextDecoder();
    
    let _inThinkingState = false;
    let _thinkingFragments: Record<string, boolean> = {};
    let currentThoughtIndex = 0;
    let _currentAppendPath = '';
    
    let reasoningBuffer = '';
    let deferredThinkingChunks: string[] = [];
let lastFullContent = '';
let lastRawContent = '';
    let lastFilteredSnapshot = '';
    let lastThinkingSnapshot = '';
    const enableContentFiltering = cleanOutput;
    const streamFilter = new StreamingContentFilter(enableContentFiltering);
    const echoDetectorEnabled = config.get('ECHO_DETECTOR', 'true') !== 'false';
    const streamingEchoFilter = new StreamingEchoFilter(echoDetectorEnabled ? toolResultContents : []);
    let lastVStrRaw = '';
    let targetResponseId: string | null = null;
    const toolParser = new StreamingToolParser();
    if (!toolCalling) toolParser.passThrough = true;

    let buffer = '';
    let completionTokens = 0;
    let promptTokens = Math.ceil(finalPrompt.length / 3.5);

    const ampState: AmplificationGuardState = { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false };

    while (true) {
      if (streamDone) break;
      if (c.req.raw?.signal?.aborted) { reader.cancel(); break; }

      let done: boolean;
      let value: Uint8Array | undefined;
      const IDLE_TIMEOUT_MS = 60_000;
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Upstream stream idle timeout — no data for 60s')), IDLE_TIMEOUT_MS);
        })
      ]);
      done = readResult.done;
      value = readResult.value;

      if (done) {
        break;
      }
      totalChunks++;
      if (value) ampState.rawInputBytes += value.length;

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

          const deltaResult = extractDeltaContent(chunk, targetResponseId, currentThoughtIndex, reasoningBuffer);
          const { vStr, foundStr, isThinkingChunk } = deltaResult;
          currentThoughtIndex = deltaResult.currentThoughtIndex;

          if (foundStr && vStr !== '') {
            if (vStr === 'FINISHED') continue;

            if (isThinkingChunk) {
              _inThinkingState = true;
              reasoningBuffer += vStr;
              deferredThinkingChunks.push(vStr);
            } else {
_inThinkingState = false;
              if (/^[\n\s]*<\/?(?:think|thinking|thought|tool_call|tool_use|function_call)[\s>]*[\n\s]*$/.test(vStr)) continue;

              logStore.addRawChunk(logId, vStr);
              streamDebugLog(completionId, 'RAW_CHUNK', vStr);
              if ((vStr.includes('"name"'))) {
                logDebug('QWEN RAW CHUNK (streaming)', vStr);
              }
              let feedStr = vStr;
              if (lastVStrRaw.length > 0) {
                const detection = detectCumulativeChunk(vStr, lastVStrRaw);
                streamDebugLog(completionId, 'CUMULATIVE_DETECT', { cumulative: detection.cumulative, deltaLen: detection.delta.length, lastLen: lastVStrRaw.length, newLen: vStr.length });
                if (detection.cumulative) {
                  feedStr = detection.delta;
                  lastVStrRaw = vStr;
                } else if (detection.delta === '') {
                  feedStr = '';
                } else {
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
              if (toolCalls.length && false) {
                logDebug('PARSED TOOL CALLS (streaming)', toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments })));
              }

              if (rawText) {
                streamDebugLog(completionId, 'RAW_TEXT', { len: rawText.length, preview: rawText.substring(0, 100) });
                if (lastRawContent.length > 0) {
                  const detection = detectCumulativeChunk(rawText, lastRawContent);
                  streamDebugLog(completionId, 'RAW_CUMULATIVE_DETECT', { cumulative: detection.cumulative, deltaLen: detection.delta.length });
                  if (detection.cumulative) {
                    lastRawContent = rawText;
                    lastFullContent += detection.delta;
                  } else if (detection.delta === '') {
                  } else {
                    lastRawContent += rawText;
                    lastFullContent += rawText;
                  }
                } else {
                  lastRawContent = rawText;
                  lastFullContent = rawText;
                }
              }

              streamFilter.feed(lastFullContent);
              
              const baseFilteredContent = enableContentFiltering
                ? filterContent(lastFullContent).cleanText
                : lastFullContent;
              const filteredThinking = enableContentFiltering
                ? filterContent(lastFullContent).thinking
                : '';
              const fullFilteredText = stripToolCallArtifacts(baseFilteredContent);

              const echoResult = streamingEchoFilter.feed(fullFilteredText);
              if (echoResult.echoDetected) {
                console.warn(`[StreamingEchoFilter] ${echoResult.reason}`);
                logStore.updateEntry(logId, entry => {
                  entry.level = 'error';
                  entry.errors.push(`[Echo Detection] ${echoResult.reason} | Matched: "${(echoResult.matchedLine || '').substring(0, 120)}"`);
                });

                reader.cancel();
                if (streamReader) streamReader.cancel();
                qwenAbortController.abort();

                // Stash correction so the SDK retry picks it up via a new session.
                // Store under both the account email AND a global key — the retry may land on a different account.
                const correction = `[ECHO DETECTED — PREVENT RECURRENCE] You repeated a tool result verbatim (${(echoResult.similarity * 100).toFixed(0)}% match). This is not allowed. Analyze the result internally, then respond to the user in your own words — never copy tool output directly into your response.`;
                pendingCorrections.set('__echo_retry__', [
                  ...(pendingCorrections.get('__echo_retry__') || []),
                  correction,
                ]);
                pendingCorrections.set(resolvedEmail, [
                  ...(pendingCorrections.get(resolvedEmail) || []),
                  correction,
                ]);

                // Abort the underlying TransformStream writer to simulate a connection drop.
                // The OpenAI SDK sees this as an APIConnectionError and automatically retries.
                // The retry comes as a fresh HTTP request → picks a new session + new account.
                try {
                  (streamWriter as any).writer.abort(new Error('connection lost'));
                } catch {}
                streamDone = true;
                return;
              }

              for (const chunk of deferredThinkingChunks) {
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: chunk })]
                });
              }
              deferredThinkingChunks = [];

              const echoFilteredText = fullFilteredText || null;

              if (parserThinking) {
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: parserThinking })]
                });
              }

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

              const pendingText = (toolCalls.length > 0 && echoFilteredText) ? echoFilteredText : null;
              const cleanedText = pendingText
                ? cleanThinkTags(pendingText)
                : (echoFilteredText ? cleanThinkTags(echoFilteredText) : null);

              if (cleanedText && !pendingText) {
                const contentDelta = stripStreamingDelta(getSnapshotDelta(cleanedText, lastFilteredSnapshot));
                lastFilteredSnapshot = cleanedText;
                if (contentDelta) {
                  if (checkAmplificationGuard(ampState, contentDelta.length, logId, resolvedEmail, body.model, lastRawContent, lastVStrRaw)) {
                    continue;
                  }
                  logStore.addProcessedOutput(logId, contentDelta);
                  ampState.emittedOutputBytes += contentDelta.length;
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
                const guard = validateSingleToolCall(tc);
                if (!guard.ok) {
                  allToolCallsValid = false;
                  logStore.updateEntry(logId, entry => {
                    entry.errors.push(`Guard rejected streaming tool call "${tc.name}": ${guard.errors.join(', ')}`);
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

              if (pendingText && allToolCallsValid && cleanedText) {
                const contentDelta = stripStreamingDelta(getSnapshotDelta(cleanedText, lastFilteredSnapshot));
                lastFilteredSnapshot = cleanedText;
                if (contentDelta) {
                  if (checkAmplificationGuard(ampState, contentDelta.length, logId, resolvedEmail, body.model, lastRawContent, lastVStrRaw)) {
                    continue;
                  }
                  logStore.addProcessedOutput(logId, contentDelta);
                  ampState.emittedOutputBytes += contentDelta.length;
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

    const remainingEchoDelta = streamingEchoFilter.flush(lastFullContent);
    if (remainingEchoDelta) {
      const flushEchoCleaned = cleanThinkTags(stripToolCallArtifacts(remainingEchoDelta));
      if (flushEchoCleaned) {
        const echoFlushDelta = stripStreamingDelta(getSnapshotDelta(flushEchoCleaned, lastFilteredSnapshot));
        lastFilteredSnapshot = flushEchoCleaned;
        if (echoFlushDelta) {
          logStore.addProcessedOutput(logId, echoFlushDelta);
          ampState.emittedOutputBytes += echoFlushDelta.length;
          await writeEvent({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [makeChoice({ content: echoFlushDelta })]
          });
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

    const { text: remainingText, toolCalls: remainingToolCalls, thinking: remainingThinking } = toolParser.flush();
    if (false) {
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
    if (remainingText) {
      lastFullContent += remainingText;
    }
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
        if (checkAmplificationGuard(ampState, contentDelta.length, logId, resolvedEmail, body.model, lastRawContent, lastVStrRaw)) {
          lastFilteredSnapshot = flushCleaned;
        } else {
          lastFilteredSnapshot = flushCleaned;
          const ct = stripStreamingDelta(contentDelta).replace(/[\n\s]*$/, '');
          if (ct) {
            logStore.addProcessedOutput(logId, ct);
            ampState.emittedOutputBytes += ct.length;
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
      const guard = validateSingleToolCall(tc);
      if (!guard.ok) {
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
      ampState.rawInputBytes > 0 ? Math.round((ampState.emittedOutputBytes / ampState.rawInputBytes) * 100) / 100 : 0;
    if (finalRatio > 2) {
      console.warn(
        `[Chat] High amplification ratio: ${finalRatio}x ` +
        `(rawIn=${ampState.rawInputBytes}B, out=${ampState.emittedOutputBytes}B) account=${resolvedEmail}`
      );
      logStore.updateEntry(logId, (entry) => {
        entry.amplificationRatio = finalRatio;
      });
    }

    logStore.updateEntry(logId, (entry) => {
      const now = Date.now();
      const startedAt = new Date(entry.timestamp).getTime();
      if (startedAt) entry.latency_ms = now - startedAt;
      if (lastFullContent) entry.remainingText = lastFullContent;
      entry.finalResponse = {
        finishReason: finalFinishReason || 'stop',
        toolCallCount: toolParser.getEmittedToolCallCount(),
        contentPreview: (lastFullContent || '').substring(0, 100),
      };
    });

    const _cleanupReader = reader;
    const _cleanupInterval = heartbeatInterval;
    const _cleanupChatId = session.chatId;
    const _cleanupParentId = nextParentId;
    const _cleanupHeaders = sessionHeaders;
    const _cleanupEmail = resolvedEmail;

    streamReleased = true;
    setTimeout(() => {
      clearInterval(_cleanupInterval);
      try { _cleanupReader.cancel(); } catch {
      }
      try { _cleanupReader.releaseLock(); } catch {
      }
      sessionPool.release(_cleanupChatId, _cleanupParentId, _cleanupHeaders, _cleanupEmail);
    }, 200);

    } finally {
      clearInterval(heartbeatInterval);
      if (!streamReleased && streamReader) {
        try { streamReader.cancel(); } catch {
        }
        try { streamReader.releaseLock(); } catch {
        }
        sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail);
      }
    }
  });
}
