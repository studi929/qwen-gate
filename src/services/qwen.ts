import { getQwenHeaders } from './playwright.ts';
import { v4 as uuidv4 } from 'uuid';
import { withRetry, CircuitBreaker, CircuitOpenError } from '../utils/retry.ts';
import { throttleAccount, pickAccount } from './auth.ts';
import { createNetworkEntry, recordResponse, recordStreamChunk, completeEntry, errorEntry } from './networkDebug.ts';
import { config } from './configService.ts';

export { fetchQwenModels, disableNativeTools, disablePersonalization, setCustomInstruction, configureAccount, deleteAllChats } from './qwenModels.ts';

export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant';
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

export interface QwenStreamResult {
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  accountEmail?: string;
  abortController: AbortController;
}

const QWEN_FETCH_TIMEOUT_MS = parseInt(config.get('QWEN_FETCH_TIMEOUT_MS', '30000'), 10);

function createFetchTimeout(): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QWEN_FETCH_TIMEOUT_MS);
  return { controller, cleanup: () => clearTimeout(timeout) };
}

const qwenCircuitBreaker = new CircuitBreaker('qwen-api', {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
});

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  chatId?: string,
  parentId?: string | null,
  accountEmail?: string
): Promise<QwenStreamResult> {
  const { headers: _headers } = await getQwenHeaders(accountEmail);
  const actualParentId: string | null = parentId !== undefined ? parentId : null;
  const timestamp = Math.floor(Date.now() / 1000);
  const fid = uuidv4();
  const model = modelId.replace('-no-thinking', '');

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId || null,
    chat_mode: 'normal',
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp: timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: false
        },
        extra: {
          meta: {
            subChatType: 't2t'
          }
        },
        sub_chat_type: 't2t',
        parent_id: actualParentId
      }
    ],
    timestamp: timestamp + 1
  };

  const url = chatId
    ? `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`
    : 'https://chat.qwen.ai/api/v2/chat/completions';

  const retryConfig = {
    maxRetries: Math.max(0, parseInt(config.get('RETRY_MAX_ATTEMPTS', '3'), 10)),
    baseDelayMs: Math.max(0, parseInt(config.get('RETRY_BASE_DELAY_MS', '1000'), 10)),
    maxDelayMs: Math.max(0, parseInt(config.get('RETRY_MAX_DELAY_MS', '30000'), 10)),
    backoffMultiplier: Math.max(0.1, parseFloat(config.get('RETRY_BACKOFF_MULTIPLIER', '2'))),
  };

  const retriesEnabled = config.get('RETRY_ENABLED', 'true') !== 'false';
  let currentAccountEmail = accountEmail;
  let lastDebugEntryId: string | null = null;
  const streamAbortController = new AbortController();

  const makeRequest = async (): Promise<{ response: Response; headers: Record<string, string> }> => {
    const { headers: reqHeaders } = await getQwenHeaders(currentAccountEmail);
    const requestHeaders: Record<string, string> = {
      'accept': 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': reqHeaders['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': chatId ? `https://chat.qwen.ai/c/${chatId}` : 'https://chat.qwen.ai/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      'user-agent': reqHeaders['user-agent'],
      'x-accel-buffering': 'no',
      'x-request-id': uuidv4(),
      'bx-ua': reqHeaders['bx-ua'],
      'bx-umidtoken': reqHeaders['bx-umidtoken'],
      'bx-v': reqHeaders['bx-v']
    };
    const debugEntry = createNetworkEntry({
      url, method: 'POST', headers: requestHeaders, body: payload,
      category: 'chat', accountEmail: currentAccountEmail,
    });
    lastDebugEntryId = debugEntry.id;
    try {
      let response: Response;
      try {
        const { controller, cleanup } = createFetchTimeout();
        controller.signal.addEventListener('abort', () => {
          if (!streamAbortController.signal.aborted) {
            streamAbortController.abort(controller.signal.reason || new Error('Fetch timeout'));
          }
        });
        streamAbortController.signal.addEventListener('abort', () => {
          if (!controller.signal.aborted) {
            controller.abort(streamAbortController.signal.reason);
          }
        });
        try {
          response = await fetch(url, {
            method: 'POST', headers: requestHeaders,
            body: JSON.stringify(payload), signal: controller.signal,
          });
        } finally { cleanup(); }
      } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        errorEntry(debugEntry.id, msg);
        throw fetchErr;
      }
      recordResponse(debugEntry.id, response);
      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            const errorJson = JSON.parse(errText);
            if (errorJson?.data?.details?.includes('chat is in progress') ||
                errorJson?.data?.details?.includes('The chat is in progress')) {
              const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
              errorEntry(debugEntry.id, errorJson.data.details);
              throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
            }
            if (errorJson?.success === false) {
              const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
              const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
              const wait = errorJson.data?.num !== undefined
                ? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
                : '';
              if (code === 'RateLimited' && currentAccountEmail) {
                const throttleMs = (errorJson.data?.num || 1) * 3600_000;
                throttleAccount(currentAccountEmail, Math.min(throttleMs, 7200_000));
                const nextAccount = pickAccount();
                if (nextAccount && nextAccount.email !== currentAccountEmail) {
                  currentAccountEmail = nextAccount.email;
                }
              }
              let status: number;
              if (code === 'RateLimited') status = 429;
              else if (code === 'Not_Found') status = 404;
              else if (code === 'UpstreamError') status = 502;
              else status = 502;
              errorEntry(debugEntry.id, `${code}: ${details}`);
              throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
            }
            if (errorJson?.data?.details?.includes('is not exist') ||
                errorJson?.data?.details?.includes('not exist') ||
                errorJson?.data?.details?.includes('does not exist')) {
              errorEntry(debugEntry.id, errorJson.data.details);
              throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, 0);
            }
          } catch (parseOrRetryError) {
            if (parseOrRetryError instanceof RetryableQwenStreamError ||
                parseOrRetryError instanceof QwenUpstreamError) {
              throw parseOrRetryError;
            }
          }
        }
        class UpstreamStatusError extends Error {
          readonly status: number;
          constructor(message: string, status: number) {
            super(message);
            this.name = 'UpstreamStatusError';
            this.status = status;
          }
        }
        throw new UpstreamStatusError(
          `Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`,
          response.status
        );
      }
      return { response, headers: reqHeaders };
    } catch (err) {
      errorEntry(debugEntry.id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  let result: { response: Response; headers: Record<string, string> };
  const cbState = qwenCircuitBreaker.getState();
  if (cbState === 'open') {
    const stats = qwenCircuitBreaker.getStats();
    const retryAfterMs = Math.max(0, 30_000 - (Date.now() - stats.lastFailureTime));
    throw new CircuitOpenError(retryAfterMs);
  }
  if (retriesEnabled && retryConfig.maxRetries > 0) {
    result = await withRetry(makeRequest, { ...retryConfig, circuitBreaker: qwenCircuitBreaker });
  } else {
    result = await makeRequest();
    qwenCircuitBreaker.recordSuccess();
  }
  if (!result.response.body) {
    throw new Error(`Qwen returned empty response body (status ${result.response.status})`);
  }
  const streamDebugEntryId = lastDebugEntryId;
  const textDecoder = new TextDecoder();
  const wrappedStream = result.response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (streamDebugEntryId) {
          recordStreamChunk(streamDebugEntryId, textDecoder.decode(chunk, { stream: true }));
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (streamDebugEntryId) {
          completeEntry(streamDebugEntryId);
        }
      }
    })
  );
  return { stream: wrappedStream, headers: result.headers, uiSessionId: chatId || '', accountEmail: currentAccountEmail, abortController: streamAbortController };
}
