import {
  parseQwenErrorPayload,
  getSnapshotDelta,
  checkAmplificationGuard,
  type AmplificationGuardState,
} from "./chatHelpers.ts";
import { logStore } from '../services/logStore.ts';
import { parseXmlToolCalls, cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import {
  writeEvent,
  writeReasoningEvent,
  makeChoice,
  buildChunkEvent,
  buildUsage,
} from "./writeHelpers.ts";
import { checkFinalAmplification, scheduleCleanup } from './cleanupHelpers.ts';
import {
  processStreamData,
  filterContentPipeline,
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

        const result = await processStreamData(chunk, streamState, streamCtx);
        if (result === 'break_stream') { streamDone = true; break; }
      } catch (e) {
        console.error('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
      }
    }
    nextParentId = streamState.nextParentId;
  }

  return { buffer: bufferRef.text, echoAborted: false, nextParentId };
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
    emittedToolCallCount: number;
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
    logId, resolvedEmail, emittedToolCallCount,
    buffer, enableContentFiltering, includeUsage,
  } = args;
  const { reader, heartbeatInterval, chatId, sessionHeaders, email, sessionPool } = cleanup;

  const upstreamError = parseQwenErrorPayload(buffer);
  if (upstreamError) {
    const cleanErrorMessage = cleanTextOfXmlArtifacts(upstreamError.message).cleanedText || upstreamError.message;
    await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: cleanErrorMessage })]));
    await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({}, 'stop')]));
    await streamWriter.write('data: [DONE]\n\n');
    logStore.updateEntry(logId, entry => { entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' }; entry.finalResponse.finishReason = 'upstream_error'; });
    logStore.finalizeRequest(logId);
    scheduleCleanup(reader, heartbeatInterval, chatId, streamState?.nextParentId, sessionHeaders, email, sessionPool);
    return;
  }

  // Count tool calls from the final assembled content
  const finalToolCalls = streamState.lastFullContent
    ? parseXmlToolCalls(streamState.lastFullContent).toolCalls.length
    : 0;
  const effectiveToolCallCount = Math.max(emittedToolCallCount, finalToolCalls);

  const pipelineResult = filterContentPipeline(streamState.lastFullContent, enableContentFiltering);
  const flushCleaned = pipelineResult.cleanText;
  const flushThinking = pipelineResult.thinking;

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
      streamState.lastFilteredSnapshot = flushCleaned;
      if (checkAmplificationGuard(ampState, contentDelta.length, logId, resolvedEmail, model, streamState.lastRawContent, streamState.lastVStrRaw)) {
        // guard triggered — skip content emission
      } else {
        const ct = contentDelta.replace(/[\n\s]*$/, '');
        if (ct) {
          logStore.addProcessedOutput(logId, ct);
          ampState.emittedOutputBytes += ct.length;
          await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: ct })]));
        }
      }
    }
  }


  const usage = buildUsage(streamState.promptTokens, streamState.completionTokens, streamState.reasoningBuffer);
  const finalFinishReason = effectiveToolCallCount > 0 ? 'tool_calls' : 'stop';

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
      toolCallCount: effectiveToolCallCount,
      contentPreview: (streamState.lastFullContent || '').substring(0, 100),
    };
  });

  logStore.finalizeRequest(logId);

  scheduleCleanup(reader, heartbeatInterval, chatId, streamState.nextParentId, sessionHeaders, email, sessionPool);
}
