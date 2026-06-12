import { Context } from "hono";
import crypto from 'node:crypto';
import { OpenAIRequest } from "../types/openai.ts";
import { config } from "../services/configService.ts";
import { logStore } from "../services/logStore.ts";
import { modelRouter } from "../services/modelRouter.ts";
import { pickAccount } from "../services/auth.ts";
import { sessionPool } from "../services/sessionPool.ts";
import { checkContextWindow, estimateTokens } from "../utils/tokenEstimator.ts";
import { handleStreamingRequest } from "./chatStreaming.ts";
import { handleNonStreamingRequest } from "./chatNonStreaming.ts";
import { cleanTextOfXmlArtifacts } from "../tools/xmlToolParser.ts";
import {
  buildQwenMessages,
  handleImageModelFallback,
  getModelSpecs,
  acquireSessionWithCorrections,
  createQwenStreamWithRetry,
} from "./chatHelpers.ts";

export {
  commonPrefixLen,
  getNewContent,
  commonSuffixLen,
  detectCumulativeChunk,
  truncateToolResult,
} from "./chatHelpers.ts";

const MAX_MESSAGE_SIZE = 100_000; // 100KB per message

async function parseRequestBody(c: Context) {
  const body: OpenAIRequest = await c.req.json();

  // Per-message size validation to prevent OOM during estimateTokens
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      if (content && content.length > MAX_MESSAGE_SIZE) {
        const err = new Error(`Message content exceeds maximum size of ${MAX_MESSAGE_SIZE} characters`);
        (err as any).upstreamStatus = 400;
        (err as any).type = 'invalid_request_error';
        (err as any).code = 'message_too_large';
        throw err;
      }
    }
  }

  let isStream = body.stream ?? false;
  const streamMode = config.get("STREAMING_MODE", "auto");
  if (streamMode === "stream") isStream = true;
  else if (streamMode === "non-stream") isStream = false;
  const toolCalling = config.get("TOOL_CALLING", "true") !== "false";
  const cleanOutput = config.get("CLEAN_OUTPUT", "true") !== "false";

  const messages = body.messages || [];
  handleImageModelFallback(body, messages);
  const { maxContext, maxOutput } = getModelSpecs(body);

  const formattedMessages = messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map((c: any) => c.text || JSON.stringify(c)).join("\n")
      : String(m.content ?? ""),
  }));
  const estimatedTokens = estimateTokens(
    formattedMessages.map((m) => m.content).join("\n"),
  );
  const contextCheck = checkContextWindow(
    estimatedTokens,
    maxContext,
    maxOutput,
    body.model as string,
    formattedMessages,
  );

  return {
    body,
    isStream,
    toolCalling,
    cleanOutput,
    messages,
    contextCheck,
    availableTokens: contextCheck.availableTokens,
  };
}

async function setupSession(
  messages: any[],
  body: OpenAIRequest,
  availableTokens: number,
  toolCalling: boolean,
  logId: string,
) {
  const { qwenMessages: processedMessages, toolResultContents } = buildQwenMessages(
    messages,
    body,
    availableTokens,
    toolCalling,
  );

  const isThinkingModel = !body.model.includes("no-thinking");

  const selectedAccount = await pickAccount();
  const accountEmail = selectedAccount?.email;

  let sessionResult;
  try {
    sessionResult = await acquireSessionWithCorrections(
      accountEmail,
      processedMessages,
    );
  } catch (err) {
    // NOTE: sessionPool.acquire() already decrements inFlight on failure,
    // so we do NOT decrement here to avoid double-decrement (which would
    // drive inFlight negative and corrupt load balancing).
    throw err;
  }
  const { session, qwenMessages: sessionMessages, nextParentId, sessionHeaders, resolvedEmail } =
    sessionResult;

  // Populate the account that served this request
  logStore.updateEntry(logId, (entry) => {
    entry.accountEmail = resolvedEmail;
  });

  let routedModel;
  let streamResult;
  try {
    routedModel = await modelRouter.route(body.model);
    streamResult = await createQwenStreamWithRetry(
      sessionMessages,
      isThinkingModel,
      routedModel,
      session.chatId,
      nextParentId,
      resolvedEmail,
      body.tools,
      body.tool_choice,
    );
  } catch (err) {
    // Release the acquired session to prevent pool exhaustion + inFlight leak
    sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
    throw err;
  }
  let { stream, abortController: qwenAbortController } = streamResult;

  // Build finalPrompt for logStore debug logging only
  const finalPrompt = sessionMessages.map((m: any) => {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content ?? '');
    return `${m.role}: ${content}`;
  }).join('\n\n');
  logStore.updateEntry(logId, (entry) => {
    entry.promptToQwen = {
      systemPromptLength: 0,
      totalLength: finalPrompt.length,
      preview: finalPrompt.length > 1000
        ? finalPrompt.substring(0, 1000) + '...'
        : finalPrompt,
    };
  });

  return {
    toolResultContents,
    sessionMessages,
    session,
    nextParentId,
    sessionHeaders,
    resolvedEmail,
    stream,
    qwenAbortController,
  };
}

function populateLogEntry(logEntry: any, body: OpenAIRequest, messages: any[]): void {
  const rawContent = messages.length > 0 ? messages[messages.length - 1].content : '';
  const lastMsg = typeof rawContent === 'string' ? rawContent : (rawContent !== undefined ? JSON.stringify(rawContent) : '');
  logEntry.clientRequest = {
    messageCount: messages.length,
    roles: messages.map((m) => m.role),
    hasTools: !!body.tools?.length,
    toolNames: body.tools?.map((t: any) => t.function?.name || t.name) || [],
    tool_choice: body.tool_choice ? (typeof body.tool_choice === "string" ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
    lastMessage: lastMsg.substring(0, 300),
    messages: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
  };
}

export async function chatCompletions(c: Context) {
  const logId = crypto.randomUUID();
  try {
    const parsed = await parseRequestBody(c);
    const { body, isStream, toolCalling, cleanOutput, messages, contextCheck } =
      parsed;
    logStore.createEntry(logId, body.model, isStream);
    const logEntry = logStore.getEntry(logId);
    if (logEntry) populateLogEntry(logEntry, body, messages);

    if (!contextCheck.ok) {
      logStore.updateEntry(logId, entry => { entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' }; entry.finalResponse.finishReason = 'context_window_exceeded'; });
      logStore.finalizeRequest(logId);
      return c.json(
        {
          error: {
            message: contextCheck.message,
            type: "invalid_request_error",
            param: "messages",
            code: "context_window_exceeded",
          },
        },
        400,
      );
    }

    const { toolResultContents, sessionMessages: _sessionMessages, session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController } =
      await setupSession(
        messages,
        body,
        contextCheck.availableTokens!,
        toolCalling,
        logId,
      );

    const completionId = "chatcmpl-" + crypto.randomUUID();

    if (!isStream) {
      return handleNonStreamingRequest({
        c,
        logId,
        completionId,
        body,
        session,
        stream,
        resolvedEmail,
        initialParentId: nextParentId,
        sessionHeaders,
        toolCalling,
        cleanOutput,
        toolResultContents,
      });
    }

    return await handleStreamingRequest({
      c,
      logId,
      completionId,
      body,
      session,
      stream,
      qwenAbortController,
      resolvedEmail,
      initialParentId: nextParentId,
      sessionHeaders,
      toolCalling,
      cleanOutput,
      toolResultContents,
    });
  } catch (err: any) {
    console.error("Error in chatCompletions:", err);
    logStore.addError(logId, err.message || String(err));
    logStore.updateEntry(logId, entry => { entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' }; entry.finalResponse.finishReason = 'error'; });
    logStore.finalizeRequest(logId);
    const status = err.upstreamStatus || 500;
    const cleanMessage = cleanTextOfXmlArtifacts(err.message || String(err)).cleanedText || err.message || 'Internal error';
    return c.json({
      error: {
        message: cleanMessage,
        type: err.type || 'server_error',
        code: err.code || undefined,
      },
    }, status);
  }
}
