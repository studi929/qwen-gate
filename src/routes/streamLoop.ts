import {
  parseQwenErrorPayload,
  getSnapshotDelta,
  cleanThinkTags,
  streamDebugLog,
  checkAmplificationGuard,
  type AmplificationGuardState,
} from './chatHelpers.ts';
import { validateSingleToolCall } from '../tools/guard.ts';
import { logStore } from '../services/logStore.ts';
import { filterContent, stripToolCallArtifacts, stripStreamingDelta } from '../utils/contentFilter.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { StreamingContentFilter } from './pipeline/StreamingContentFilter.ts';
import { StreamingEchoFilter } from './pipeline/StreamingEchoFilter.ts';
import {
  writeEvent,
  writeReasoningEvent,
  writeContentDelta,
  writeToolCallEvent,
  makeChoice,
  buildChunkEvent,
  buildUsage,
} from './writeHelpers.ts';
import { checkFinalAmplification, scheduleCleanup } from './cleanupHelpers.ts';
import {
  processStreamData,
  type StreamProcessingState,
  type StreamProcessingCtx,
} from './chatStreamingHelpers.ts';

export interface StreamLoopResult {
  buffer: string;
  echoAborted: boolean;
  nextParentId: string | null;
}

export async function runStreamLoop(
  c: { req: { raw?: { signal?: AbortSignal } } },
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  streamState: StreamProcessingState,
  streamCtx: StreamProcessingCtx,
  ampState: AmplificationGuardState,
  bufferRef: { text: string },
): Promise<StreamLoopResult> {
  let streamDone = false;
  let echoAborted = false;
  let nextParentId = streamState.nextParentId;
  let _totalChunks = 0;

  while (true) {
    if (streamDone) break;
    if (c.req.raw?.signal?.aborted) { reader.cancel(); break; }

    const IDLE_TIMEOUT_MS = 60_000;
    const readResult = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Upstream stream idle timeout — no data for 60s')), IDLE_TIMEOUT_MS);
      }),
    ]);
    if (readResult.done) break;
    _totalChunks++;
    if (readResult.value) ampState.rawInputBytes += readResult.value.length;

    const rawDecoded = decoder.decode(readResult.value, { stream: true });
    streamDebugLog(streamCtx.completionId, 'WIRE_CHUNK', { chunkNum: _totalChunks, byteLen: readResult.value?.length ?? 0, preview: rawDecoded.substring(0, 300) });
    bufferRef.text += rawDecoded;
    const lines = bufferRef.text.split('\n');
    bufferRef.text = lines.pop() || '';

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
        streamDebugLog(streamCtx.completionId, 'SSE_EVENT', {
          phase: chunk.choices?.[0]?.delta?.phase,
          hasContent: !!chunk.choices?.[0]?.delta?.content,
          hasToolCalls: !!chunk.choices?.[0]?.delta?.tool_calls,
          contentLen: chunk.choices?.[0]?.delta?.content?.length ?? 0,
          dataPreview: dataStr.substring(0, 300),
        });

        const result = await processStreamData(chunk, streamState, streamCtx);
        if (result === 'abort_stream') { echoAborted = true; break; }
        if (result === 'break_stream') { streamDone = true; break; }
      } catch (e) {
        console.error('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
      }
    }
    if (echoAborted) break;
    nextParentId = streamState.nextParentId;
  }

  return { buffer: bufferRef.text, echoAborted, nextParentId };
}

export async function handlePostStreamCompletion(
  args: {
    streamWriter: any;
    completionId: string;
    model: string;
    streamState: StreamProcessingState;
    ampState: AmplificationGuardState;
    logId: string;
    resolvedEmail: string;
    streamingEchoFilter: StreamingEchoFilter;
    toolParser: StreamingToolParser;
    streamFilter: StreamingContentFilter;
    buffer: string;
    enableContentFiltering: boolean;
    includeUsage: boolean;
  },
  cleanup: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    heartbeatInterval: any;
    chatId: string;
    sessionHeaders: any;
    email: string;
    sessionPool: { release: (chatId: string, parentId: string | null, headers: any, email: string) => void };
  },
): Promise<void> {
  const {
    streamWriter, completionId, model, streamState, ampState,
    logId, resolvedEmail, streamingEchoFilter, toolParser, streamFilter,
    buffer, enableContentFiltering, includeUsage,
  } = args;
  const { reader, heartbeatInterval, chatId, sessionHeaders, email, sessionPool } = cleanup;

  const remainingEchoDelta = streamingEchoFilter.flush(streamState.lastFullContent);
  if (remainingEchoDelta) {
    const flushEchoCleaned = cleanThinkTags(stripToolCallArtifacts(remainingEchoDelta));
    if (flushEchoCleaned) {
      const echoFlushDelta = stripStreamingDelta(getSnapshotDelta(flushEchoCleaned, streamState.lastFilteredSnapshot));
      streamState.lastFilteredSnapshot = flushEchoCleaned;
      if (echoFlushDelta) {
        await writeContentDelta(streamWriter, completionId, model, echoFlushDelta, ampState, logId, resolvedEmail, streamState.lastRawContent, streamState.lastVStrRaw, logStore);
      }
    }
  }

  const upstreamError = parseQwenErrorPayload(buffer);
  if (upstreamError) {
    await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: upstreamError.message })]));
    await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({}, 'stop')]));
    await streamWriter.write('data: [DONE]\n\n');
    return;
  }

  const { text: remainingText, toolCalls: remainingToolCalls, thinking: remainingThinking } = toolParser.flush();
  if (remainingThinking) {
    await writeReasoningEvent(streamWriter, completionId, model, remainingThinking);
  }
  if (remainingText) {
    streamState.lastFullContent += remainingText;
  }
  streamFilter.flush();
  const { cleanText: flushBase, thinking: flushThinking } = (enableContentFiltering && streamState.lastFullContent)
    ? filterContent(streamState.lastFullContent)
    : { cleanText: streamState.lastFullContent || '', thinking: '' };
  const flushFiltered = stripToolCallArtifacts(flushBase);
  const flushCleaned = cleanThinkTags(flushFiltered);

  if (flushThinking) {
    const thinkDelta = getSnapshotDelta(flushThinking, streamState.lastThinkingSnapshot);
    if (thinkDelta) {
      streamState.lastThinkingSnapshot = flushThinking;
      await writeReasoningEvent(streamWriter, completionId, model, thinkDelta);
    }
  }
  if (flushCleaned) {
    const contentDelta = getSnapshotDelta(flushCleaned, streamState.lastFilteredSnapshot);
    if (contentDelta) {
      if (checkAmplificationGuard(ampState, contentDelta.length, logId, resolvedEmail, model, streamState.lastRawContent, streamState.lastVStrRaw)) {
        streamState.lastFilteredSnapshot = flushCleaned;
      } else {
        streamState.lastFilteredSnapshot = flushCleaned;
        const ct = stripStreamingDelta(contentDelta).replace(/[\n\s]*$/, '');
        if (ct) {
          logStore.addProcessedOutput(logId, ct);
          ampState.emittedOutputBytes += ct.length;
          await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: ct })]));
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
    await writeToolCallEvent(streamWriter, completionId, model, tc, toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc));
  }

  const usage = buildUsage(streamState.promptTokens, streamState.completionTokens, streamState.reasoningBuffer);
  const finalFinishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';

  await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({}, finalFinishReason)],
    includeUsage ? undefined : { usage },
  ));

  if (includeUsage) {
    await writeEvent(streamWriter, buildChunkEvent(completionId, model, [], { usage }));
  }
  await streamWriter.write('data: [DONE]\n\n');

  checkFinalAmplification(ampState, logId, resolvedEmail, logStore);

  logStore.updateEntry(logId, (entry) => {
    const now = Date.now();
    const startedAt = new Date(entry.timestamp).getTime();
    if (startedAt) entry.latency_ms = now - startedAt;
    if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
    entry.finalResponse = {
      finishReason: finalFinishReason || 'stop',
      toolCallCount: toolParser.getEmittedToolCallCount(),
      contentPreview: (streamState.lastFullContent || '').substring(0, 100),
    };
  });

  logStore.finalizeRequest(logId);

  scheduleCleanup(reader, heartbeatInterval, chatId, streamState.nextParentId, sessionHeaders, email, sessionPool);
}
