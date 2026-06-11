import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import type { OpenAIRequest, Message } from '../types/openai.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { type AmplificationGuardState } from './chatHelpers.ts';
import {
  writeEvent,
  makeChoice,
  buildChunkEvent,
} from './writeHelpers.ts';
import {
  cleanupImmediately,
} from './cleanupHelpers.ts';
import { logStore } from '../services/logStore.ts';
import {
  type StreamProcessingState,
  type StreamProcessingCtx,
} from './chatStreamingHelpers.ts';
import {
  runStreamLoop,
  handlePostStreamCompletion,
} from './streamLoop.ts';

export interface StreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  qwenAbortController: AbortController;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  toolResultContents: string[];
  qwenLogFile?: string;
}

function buildPromptString(messages: Message[]): string {
  return messages.map(m => {
    const content = Array.isArray(m.content)
      ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
      : String(m.content ?? '');
    return `${m.role}: ${content}`;
  }).join('\n\n');
}

export async function handleStreamingRequest(ctx: StreamingContext): Promise<Response> {
  const { c, logId, completionId, body, session, stream, qwenAbortController, resolvedEmail, sessionHeaders, toolCalling: _toolCalling, cleanOutput, toolResultContents: _toolResultContents } = ctx;

  const finalPrompt = buildPromptString(body.messages);

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'close');

  return honoStream(c, async (streamWriter: any) => {
    let streamReleased = false;
    let heartbeatInterval: any;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const ampState: AmplificationGuardState = { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false };

    try {
      heartbeatInterval = createHeartbeat(streamWriter);
      await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({ role: 'assistant', content: '' })]));

      streamReader = stream.getReader();
      const reader: ReadableStreamDefaultReader<Uint8Array> = streamReader;
      const decoder = new TextDecoder();
      const enableContentFiltering = cleanOutput;
      const streamState = buildInitialStreamState(finalPrompt, ctx.initialParentId);

      const streamCtx: StreamProcessingCtx = {
        streamWriter, completionId, model: body.model,
        enableContentFiltering, cleanOutput,
        logId, resolvedEmail, ampState, reader, streamReader, qwenAbortController,
        qwenLogFile: ctx.qwenLogFile,
        emittedToolCallCount: 0,
      };

      const bufferRef = { text: '' };
      const loopResult = await runStreamLoop(c, reader, decoder, streamState, streamCtx, ampState, bufferRef);

      if (loopResult.echoAborted) {
        logStore.updateEntry(logId, entry => {
          entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
          entry.finalResponse.finishReason = 'stop';
        });
        logStore.finalizeRequest(logId);
        return;
      }

      await handlePostStreamCompletion(
        {
          streamWriter, completionId, model: body.model, streamState, ampState,
          logId, resolvedEmail, emittedToolCallCount: streamCtx.emittedToolCallCount,
          buffer: loopResult.buffer, enableContentFiltering,
          includeUsage: !!body.stream_options?.include_usage,
        },
        {
          reader, heartbeatInterval, chatId: session.chatId,
          sessionHeaders, email: resolvedEmail, sessionPool,
        },
      );

      streamReleased = true;
    } finally {
      if (!streamReleased) {
        logStore.updateEntry(logId, entry => {
          entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
          entry.finalResponse.finishReason = entry.finalResponse.finishReason || 'stop';
        });
        logStore.finalizeRequest(ctx.logId);
        cleanupImmediately(streamReader, heartbeatInterval, session.chatId, ctx.initialParentId, sessionHeaders, resolvedEmail, sessionPool);
      }
    }
  });
}

function createHeartbeat(streamWriter: any): any {
  const hb = setInterval(async () => {
    try {
      await streamWriter.write(': keep-alive\n\n');
    } catch (_e) {
      clearInterval(hb);
    }
  }, 15000);
  if (hb && typeof hb.unref === 'function') hb.unref();
  return hb;
}

function buildInitialStreamState(finalPrompt: string, initialParentId: string | null): StreamProcessingState {
  return {
    targetResponseId: null,
    nextParentId: initialParentId,
    completionTokens: 0,
    promptTokens: Math.ceil(finalPrompt.length / 3.5),
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    deferredThinkingChunks: [],
    lastFullContent: '',
    lastRawContent: '',
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    loggedToolCalls: new Set(),
    emittedToolCalls: new Set(),
  };
}
