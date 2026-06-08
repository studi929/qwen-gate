import { randomUUID } from "node:crypto";
import { logStore } from "../services/logStore.ts";
import { sessionPool } from "../services/sessionPool.ts";
import { createQwenStream } from "../services/qwen.ts";
import { modelRouter } from "../services/modelRouter.ts";
import modelSpecs from "../models.json" with { type: "json" };
import type { ModelSpec } from "../utils/types.ts";
import { safeTruncate, pendingCorrections } from "./chatHelpersCore.ts";
import { compressToolResult } from "./compressToolResult.ts";

// Re-export everything from core utilities
export * from "./chatHelpersCore.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: "user" | "assistant" | "function";
  content: string | Record<string, any>;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: Record<string, any>;
  extra: Record<string, any>;
  sub_chat_type: string;
  parent_id: string | null;
  // Function-specific fields (only for role: 'function')
  model?: string;
  modelName?: string;
  modelIdx?: number;
  userContext?: any;
  info?: Record<string, any>;
}

export interface BuildQwenMessagesResult {
  qwenMessages: QwenMessage[];
  toolResultContents: string[];
}

// ── Business logic ───────────────────────────────────────────────

export function buildQwenMessages(
  messages: any[],
  body: any,
  availableTokens: number,
  _toolCalling: boolean,
  clientName?: string,
): BuildQwenMessagesResult {
  const qwenMessages: QwenMessage[] = [];
  const toolResultContents: string[] = [];
  const timestamp = Math.floor(Date.now() / 1000);
  const model = (body.model || "").replace("-no-thinking", "");
  const resolvedClientName = clientName || "gateway";

  let accumulatedSystemContent = "";
  let userTurns = 0;
  const turnToolResults: Array<{ turn: number; content: string }> = [];

  // Limit messages to last 20 to avoid Qwen's "too many messages" error
  const MAX_MESSAGES = 20;
  const startIdx = Math.max(0, messages.length - MAX_MESSAGES);
  for (let i = startIdx; i < messages.length; i++) {
    const msg = messages[i];

    let contentStr = "";
    if (Array.isArray(msg.content)) {
      contentStr = msg.content
        .map((c: any) => c.text || JSON.stringify(c))
        .join("\n");
    } else if (typeof msg.content === "object" && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || "";
    }

    if (msg.role === "system") {
      accumulatedSystemContent += (contentStr || "") + "\n\n";
    } else if (msg.role === "user") {
      userTurns++;

      // Sanitize content
      let sanitized = contentStr
        .replace(
          /<(?:system|instruction|prompt|rule)\b[^>]*>[\s\S]*?<\/(?:system|instruction|prompt|rule)>/gi,
          "",
        )
        .replace(
          /<(?:think|thinking|thought|tool_call|tool_use|function_call|tool)\b[^>]*>[\s\S]*?<\/(?:think|thinking|thought|tool_call|tool_use|function_call|tool)>/gi,
          "",
        )
        .replace(/^(?:System|Assistant|User|Human):\s*/gim, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

      // Prepend accumulated system content to the first user message
      if (accumulatedSystemContent && qwenMessages.length === 0) {
        sanitized = accumulatedSystemContent + sanitized;
        accumulatedSystemContent = "";
      }

      // Truncate if needed
      const charLimit = Math.floor(availableTokens * 3.0);
      const truncated =
        sanitized.length > charLimit
          ? sanitized.substring(0, charLimit) +
            `\n\n[TRUNCATED: input exceeded ${charLimit} characters (model: ${body.model}, available tokens: ${availableTokens})]`
          : sanitized;

      const featureConfig: Record<string, any> = {
        thinking_enabled: true,
        output_schema: "phase",
        research_mode: "normal",
        auto_thinking: false,
        thinking_mode: "Thinking",
        thinking_format: "summary",
        auto_search: false,
      };

      if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
        const localMcp: Record<string, any> = {};
        localMcp[resolvedClientName] = {};
        for (const t of body.tools) {
          const fn = t.function || {};
          localMcp[resolvedClientName][fn.name] = {
            description: fn.description || "",
            input_schema: fn.parameters || { type: "object", properties: {} },
          };
        }
        featureConfig.local_mcp = localMcp;
      }

      qwenMessages.push({
        fid: randomUUID(),
        parentId: null,
        childrenIds: [],
        role: "user",
        content: truncated || "",
        user_action: "chat",
        files: [],
        timestamp,
        models: [model],
        chat_type: "t2t",
        feature_config: featureConfig,
        extra: {
          meta: {
            subChatType: "t2t",
          },
        },
        sub_chat_type: "t2t",
        parent_id: null,
      });
    } else if (msg.role === "assistant") {
      let assistantContent = contentStr || "";
      const reasoning = msg.reasoning_content;
      if (reasoning) assistantContent = `${reasoning}\n\n${assistantContent}`;

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: any = {};
          const args = tc.function?.arguments;
          if (typeof args === "string") {
            try {
              parsedArgs = JSON.parse(args);
            } catch {
              parsedArgs = {};
            }
          } else if (args && typeof args === "object") {
            parsedArgs = args;
          }
          const xmlParams = Object.entries(parsedArgs)
            .map(([k, v]) => `<parameter=${k}>${String(v)}</parameter>`)
            .join("\n");
          const xmlPayload = `<function=${tc.function?.name}>\n${xmlParams}\n</function>`;
          assistantContent = assistantContent
            ? assistantContent + "\n" + xmlPayload
            : xmlPayload;
        }
      }

      qwenMessages.push({
        fid: randomUUID(),
        parentId: null,
        childrenIds: [],
        role: "assistant",
        content: assistantContent,
        user_action: "chat",
        files: [],
        timestamp,
        models: [model],
        chat_type: "t2t",
        feature_config: {},
        extra: {
          meta: {
            subChatType: "t2t",
          },
        },
        sub_chat_type: "t2t",
        parent_id: null,
      });
    } else if (msg.role === "tool" || msg.role === "function") {
      // Resolve tool name
      let toolName = msg.name;
      if (!toolName && msg.tool_call_id) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === "assistant" && prevMsg.tool_calls) {
            const call = prevMsg.tool_calls.find(
              (tc: any) => tc.id === msg.tool_call_id,
            );
            if (call) {
              toolName = call.function?.name;
              break;
            }
          }
        }
      }

      const truncated = compressToolResult(contentStr || "");
      const canary = `[tc-${randomUUID().substring(0, 8)}]`;

      // Build function content: {clientName: [{toolName: result}]}
      const inner = JSON.stringify({
        success: true,
        stdout: truncated,
        stderr: "",
        command: toolName || "",
      });
      const qwenResultStr = JSON.stringify([
        { type: "text", text: `${canary}\n${inner}` },
      ]);
      const funcContent: Record<string, any> = {};
      funcContent[resolvedClientName] = [
        { [toolName || "unknown"]: qwenResultStr },
      ];

      qwenMessages.push({
        fid: randomUUID(),
        parentId: null,
        childrenIds: [],
        role: "function",
        content: funcContent,
        user_action: "chat",
        files: [],
        timestamp,
        models: [model],
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: true,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: false,
          thinking_mode: "Thinking",
        },
        extra: {
          meta: {
            subChatType: "t2t",
          },
        },
        sub_chat_type: "t2t",
        parent_id: null,
        model: model,
        modelName: model,
        modelIdx: 0,
        userContext: null,
        info: {},
      });
 
      // Track for echo filter
      const canaryContent = `${canary}\n${truncated}`;
      turnToolResults.push({ turn: userTurns, content: canaryContent });
    }
  }

  // If there's leftover system content, prepend to the first message
  if (accumulatedSystemContent && qwenMessages.length > 0) {
    const first = qwenMessages[0];
    if (typeof first.content === "string") {
      qwenMessages[0] = {
        ...first,
        content: accumulatedSystemContent + first.content,
      };
    }
  }

  // Build toolResultContents for echo filter (keep existing logic)
  const MAX_TOOL_RESULT_TURNS = 2;
  const turnsWithResults = [
    ...new Set(turnToolResults.map((r) => r.turn)),
  ].sort((a, b) => b - a);
  const recentTurns = new Set(turnsWithResults.slice(0, MAX_TOOL_RESULT_TURNS));
  for (const item of turnToolResults) {
    if (recentTurns.has(item.turn)) toolResultContents.push(item.content);
  }

  return { qwenMessages, toolResultContents };
}

export function createLogEntry(
  logId: string,
  body: any,
  isStream: boolean,
  messages: any[],
  lastMsgContent: string,
): any {
  const logEntry = logStore.createEntry(logId, body.model, isStream);
  logStore.log("info", "request", "Chat request: model=" + body.model + " stream=" + isStream);
  logEntry.clientRequest = {
    messageCount: messages.length,
    roles: messages.map((m) => m.role),
    hasTools: !!body.tools?.length,
    toolNames: body.tools?.map((t: any) => t.function.name) || [],
    tool_choice: body.tool_choice
      ? typeof body.tool_choice === "string"
        ? body.tool_choice
        : JSON.stringify(body.tool_choice)
      : null,
    lastMessage: lastMsgContent ? safeTruncate(lastMsgContent, 300) : "",
    messages: messages.map(function (m: any) {
      var txt = Array.isArray(m.content)
        ? m.content
            .filter(function (p: any) {
              return p.type === "text";
            })
            .map(function (p: any) {
              return p.text;
            })
            .join(" ")
        : String(m.content ?? "");
      return { role: m.role, content: txt };
    }),
  };
  const maxRequestBody = 4096;
  const rawBodyStr = JSON.stringify(body);
  logEntry.rawRequestBody =
    rawBodyStr.length > maxRequestBody
      ? rawBodyStr.substring(0, maxRequestBody) + "... [truncated]"
      : rawBodyStr;
  logStore.saveRequestInput(logId, body);
  return logEntry;
}

export function handleImageModelFallback(body: any, messages: any[]): void {
  const hasImages = messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((c: any) => c.type === "image_url"),
  );
  if (hasImages) {
    const modelId = (body.model as string)
      .toLowerCase()
      .replace(/\./g, "-")
      .replace(/-no-thinking$/, "");
    const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
    const supportsImages = specs?.modalities.includes("image");
    if (!supportsImages) {
      const original = body.model;
      body.model =
        "qwen3.6-plus" + (original.includes("-no-thinking") ? "-no-thinking" : "");
    }
  }
}

export function getModelSpecs(
  body: any,
): { maxContext: number; maxOutput: number } {
  const modelId = (body.model as string)
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/-no-thinking$/, "");
  const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
  return {
    maxContext: specs?.max_context || 250000,
    maxOutput: specs?.max_output || 65000,
  };
}

export async function acquireSessionWithCorrections(
  accountEmail: string | undefined,
  qwenMessages: QwenMessage[],
): Promise<{
  session: any;
  qwenMessages: QwenMessage[];
  nextParentId: string | null;
  sessionHeaders: any;
  resolvedEmail: string;
}> {
  const session = await sessionPool.acquire(accountEmail);
  const prevCorrections =
    pendingCorrections.get(session.chatId) ||
    (accountEmail ? pendingCorrections.get(accountEmail) : undefined) ||
    pendingCorrections.get("__echo_retry__");
  if (prevCorrections && prevCorrections.length > 0) {
    pendingCorrections.delete(session.chatId);
    if (accountEmail) pendingCorrections.delete(accountEmail);
    pendingCorrections.delete("__echo_retry__");
    const correctionsBlock = prevCorrections
      .map((c: string, i: number) => `${i + 1}. ${c}`)
      .join("\n");
    const correctionText = `### FEEDBACK FROM PREVIOUS TURN\nThe following issues were detected in your previous response. Address them now:\n${correctionsBlock}\n\n`;

    // Prepend correction text to the first message's content
    qwenMessages = qwenMessages.map((m, idx) => {
      if (idx === 0 && typeof m.content === "string") {
        return { ...m, content: correctionText + m.content };
      }
      return m;
    });
  }
  const nextParentId: string | null = session.parentId;
  const sessionHeaders = session.cachedHeaders || {};
  const resolvedEmail = session.accountEmail || accountEmail || "";
  return { session, qwenMessages, nextParentId, sessionHeaders, resolvedEmail };
}

export async function createQwenStreamWithRetry(
  qwenMessages: QwenMessage[],
  isThinkingModel: boolean,
  routedModel: string,
  chatId: string,
  nextParentId: string | null,
  resolvedEmail: string,
  tools?: unknown[],
): Promise<{ stream: ReadableStream; abortController: AbortController }> {
  try {
    const result = await createQwenStream(
      qwenMessages,
      isThinkingModel,
      routedModel,
      chatId,
      nextParentId,
      resolvedEmail,
      tools,
    );
    modelRouter.recordSuccess(routedModel);
    return { stream: result.stream, abortController: result.abortController };
  } catch (err: any) {
    modelRouter.recordError(routedModel);
    sessionPool.release(chatId, nextParentId, undefined, resolvedEmail);
    throw err;
  }
}

export function logIncomingRequest(
  _body: any,
  _isStream: boolean,
  _messages: any[],
): void {
  // Debug logging intentionally disabled
}
