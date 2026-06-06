import { Context } from "hono";
import { v4 as uuidv4 } from "uuid";
import { OpenAIRequest } from "../utils/types.ts";
import { config } from "../services/configService.ts";
import { logStore } from "../services/logStore.ts";
import { modelRouter } from "../services/modelRouter.ts";
import { pickAccount } from "../services/auth.ts";
import { checkContextWindow, estimateTokens } from "../utils/tokenEstimator.ts";
import { handleStreamingRequest } from "./chatStreaming.ts";
import { handleNonStreamingRequest } from "./chatNonStreaming.ts";
import {
  buildPromptAndSystem,
  handleImageModelFallback,
  getModelSpecs,
  acquireSessionWithCorrections,
  createQwenStreamWithRetry,
  logIncomingRequest,
} from "./chatHelpers.ts";

export {
  commonPrefixLen,
  getNewContent,
  commonSuffixLen,
  detectCumulativeChunk,
  truncateToolResult,
} from "./chatHelpers.ts";

async function parseRequestBody(c: Context) {
  const body: OpenAIRequest = await c.req.json();
  let isStream = body.stream ?? false;
  const streamMode = config.get("STREAMING_MODE", "auto");
  if (streamMode === "stream") isStream = true;
  else if (streamMode === "non-stream") isStream = false;
  const toolCalling = config.get("TOOL_CALLING", "true") !== "false";
  const cleanOutput = config.get("CLEAN_OUTPUT", "true") !== "false";

  const messages = body.messages || [];
  logIncomingRequest(body, isStream, messages);

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
  const promptResult = buildPromptAndSystem(
    messages,
    body,
    availableTokens,
    toolCalling,
  );
  let prompt = promptResult.prompt;
  let systemPrompt = promptResult.systemPrompt;
  const toolResultContents = promptResult.toolResultContents;

  const isThinkingModel = !body.model.includes("no-thinking");

  const selectedAccount = pickAccount();
  const accountEmail = selectedAccount?.email;

  let sessionResult = await acquireSessionWithCorrections(
    accountEmail,
    systemPrompt,
    prompt,
  );
  let { session, nextParentId, sessionHeaders, resolvedEmail } =
    sessionResult;
  systemPrompt = sessionResult.systemPrompt;
  let finalPrompt = sessionResult.finalPrompt;
  // Populate the account that served this request
  logStore.updateEntry(logId, (entry) => {
    entry.accountEmail = resolvedEmail;
  });
  const routedModel = await modelRouter.route(body.model);
  let { stream, abortController: qwenAbortController } =
    await createQwenStreamWithRetry(
      finalPrompt,
      isThinkingModel,
      routedModel,
      session.chatId,
      nextParentId,
      resolvedEmail,
    );

  return {
    toolResultContents,
    finalPrompt,
    session,
    nextParentId,
    sessionHeaders,
    resolvedEmail,
    stream,
    qwenAbortController,
  };
}

export async function chatCompletions(c: Context) {
  const logId = uuidv4();
  const parsed = await parseRequestBody(c);
  const { body, isStream } = parsed;
  logStore.createEntry(logId, body.model, isStream);
  try {
    const parsed = await parseRequestBody(c);
    const { body, isStream, toolCalling, cleanOutput, messages, contextCheck } =
      parsed;

    if (!contextCheck.ok) {
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

    const { toolResultContents, finalPrompt, session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController } =
      await setupSession(
        messages,
        body,
        contextCheck.availableTokens!,
        toolCalling,
        logId,
      );

    const completionId = "chatcmpl-" + uuidv4();

    if (!isStream) {
      return handleNonStreamingRequest({
        c,
        logId,
        completionId,
        body,
        finalPrompt,
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
      finalPrompt,
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
    const status = err.upstreamStatus || 500;
    return c.json({ error: { message: err.message } }, status);
  }
}
