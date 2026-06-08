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

// ── Business logic ───────────────────────────────────────────────

export interface PromptBuildResult {
  prompt: string;
  systemPrompt: string;
  toolResultContents: string[];
}

export function buildPromptAndSystem(
  messages: any[],
  body: any,
  availableTokens: number,
  _toolCalling: boolean,
): PromptBuildResult {
  let prompt = "";
  let systemPrompt = "";
  const toolResultContents: string[] = [];
  let userTurns = 0;
  const turnToolResults: Array<{ turn: number; content: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let contentStr = "";
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join("\n");
    } else if (typeof msg.content === "object" && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || "";
    }

    if (msg.role === "system") {
      systemPrompt += (contentStr || "") + "\n\n";
    } else if (msg.role === "user") {
      userTurns++;
      const sanitized = contentStr
        .replace(/<(?:system|instruction|prompt|rule)\b[^>]*>[\s\S]*?<\/(?:system|instruction|prompt|rule)>/gi, "")
        .replace(/<(?:think|thinking|thought|tool_call|tool_use|function_call|tool)\b[^>]*>[\s\S]*?<\/(?:think|thinking|thought|tool_call|tool_use|function_call|tool)>/gi, "")
        .replace(/^(?:System|Assistant|User|Human):\s*/gim, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      const charLimit = Math.floor(availableTokens * 3.0);
      const truncated = sanitized.length > charLimit
        ? sanitized.substring(0, charLimit) + `\n\n[TRUNCATED: input exceeded ${charLimit} characters (model: ${body.model}, available tokens: ${availableTokens})]`
        : sanitized;
      prompt += `User: ${truncated || ""}\n\n`;
    } else if (msg.role === "assistant") {
      let assistantContent = contentStr || "";
      const reasoning = msg.reasoning_content;
      if (reasoning) assistantContent = `${reasoning}\n\n${assistantContent}`;
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let parsedArgs: any = {};
          const args = tc.function?.arguments;
          if (typeof args === "string") { try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; } }
          else if (args && typeof args === "object") parsedArgs = args;
          const payload = { name: tc.function?.name, arguments: parsedArgs };
          assistantContent = assistantContent ? assistantContent + "\n" + JSON.stringify(payload) : JSON.stringify(payload);
        }
      }
      prompt += `Assistant: ${assistantContent}\n\n`;
    } else if (msg.role === "tool" || msg.role === "function") {
      let toolName = msg.name;
      if (!toolName && msg.tool_call_id) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === "assistant" && prevMsg.tool_calls) {
            const call = prevMsg.tool_calls.find((tc: any) => tc.id === msg.tool_call_id);
            if (call) { toolName = call.function?.name; break; }
          }
        }
      }
      const truncated = compressToolResult(contentStr || "");
      const callId = msg.tool_call_id || `anon_${i}`;
      const canary = `[tc-${randomUUID().substring(0, 8)}]`;
      const inner = JSON.stringify({ success: true, stdout: truncated, stderr: "", command: toolName || "" });
      const qwenResult = JSON.stringify([{ type: "text", text: `${canary}\n${inner}` }]);
      prompt += `${qwenResult}\n\n`;
      const canaryContent = `${canary}\n${truncated}`;
      turnToolResults.push({ turn: userTurns, content: canaryContent });
    }
  }

  const MAX_TOOL_RESULT_TURNS = 2;
  const turnsWithResults = [...new Set(turnToolResults.map(r => r.turn))].sort((a, b) => b - a);
  const recentTurns = new Set(turnsWithResults.slice(0, MAX_TOOL_RESULT_TURNS));
  for (const item of turnToolResults) {
    if (recentTurns.has(item.turn)) toolResultContents.push(item.content);
  }

  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const formattedTools = body.tools.map((t: any) => ({
      name: t.function.name,
      description: (t.function.description || "") + " IMPORTANT: Never repeat the output of this tool verbatim to the user. Only use the output internally to inform your response.",
      parameters: t.function.parameters,
    }));
    const toolsJson = JSON.stringify(formattedTools, null, 2);
    systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to:\n${toolsJson}\n\n`;
    systemPrompt += `To call a tool, use your native XML format: <function=name><parameter=key>value</parameter></function>. Do NOT use JSON format. Example: <function=bash><parameter=command>ls -la</parameter></function>\n\n`;
    if (body.tool_choice === "required" || body.tool_choice === "any") {
      systemPrompt += `CRITICAL: Call tools to gather the information you need. After receiving each tool result, READ and ANALYZE it carefully. If the results give you enough information to answer the user, respond directly — do NOT continue calling tools unnecessarily. Only call additional tools if you genuinely need more data. NEVER call the same tool repeatedly with the same arguments.\n\n`;
    } else if (body.tool_choice === "none") {
      systemPrompt += `IMPORTANT: Do NOT use any tools. Respond to the user directly.\n\n`;
    } else if (body.tool_choice && typeof body.tool_choice === "object" && "function" in body.tool_choice) {
      systemPrompt += `CRITICAL: You MUST call the tool "${body.tool_choice.function.name}" in this response.\n\n`;
    }
  }
  return { prompt, systemPrompt, toolResultContents };
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
    tool_choice: body.tool_choice ? (typeof body.tool_choice === "string" ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
    lastMessage: lastMsgContent ? safeTruncate(lastMsgContent, 300) : "",
    messages: messages.map(function (m: any) {
      var txt = Array.isArray(m.content)
        ? m.content.filter(function (p: any) { return p.type === "text"; }).map(function (p: any) { return p.text; }).join(" ")
        : String(m.content ?? "");
      return { role: m.role, content: txt };
    }),
  };
  const maxRequestBody = 4096;
  const rawBodyStr = JSON.stringify(body);
  logEntry.rawRequestBody = rawBodyStr.length > maxRequestBody ? rawBodyStr.substring(0, maxRequestBody) + "... [truncated]" : rawBodyStr;
  logStore.saveRequestInput(logId, body);
  return logEntry;
}

export function handleImageModelFallback(body: any, messages: any[]): void {
  const hasImages = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "image_url"),
  );
  if (hasImages) {
    const modelId = (body.model as string).toLowerCase().replace(/\./g, "-").replace(/-no-thinking$/, "");
    const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
    const supportsImages = specs?.modalities.includes("image");
    if (!supportsImages) {
      const original = body.model;
      body.model = "qwen3.6-plus" + (original.includes("-no-thinking") ? "-no-thinking" : "");
    }
  }
}

export function getModelSpecs(body: any): { maxContext: number; maxOutput: number } {
  const modelId = (body.model as string).toLowerCase().replace(/\./g, "-").replace(/-no-thinking$/, "");
  const specs = (modelSpecs as Record<string, ModelSpec>)[modelId];
  return { maxContext: specs?.max_context || 250000, maxOutput: specs?.max_output || 65000 };
}

export function logPromptToQwen(logEntry: any, systemPrompt: string, prompt: string, finalPrompt: string): void {
  logEntry.promptToQwen = {
    systemPromptLength: systemPrompt.length,
    totalLength: finalPrompt.length,
    preview: (systemPrompt.length > 500 ? systemPrompt.substring(0, 500) + "..." : systemPrompt) +
      "\n\n" + (prompt.length > 200 ? prompt.substring(0, 200) + "..." : prompt),
  };
}

export async function acquireSessionWithCorrections(
  accountEmail: string | undefined,
  systemPrompt: string,
  prompt: string,
): Promise<{
  session: any;
  systemPrompt: string;
  finalPrompt: string;
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
    const correctionsBlock = prevCorrections.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n");
    systemPrompt += `\n### FEEDBACK FROM PREVIOUS TURN\nThe following issues were detected in your previous response. Address them now:\n${correctionsBlock}\n\n`;
  }
  const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
  const nextParentId: string | null = session.parentId;
  const sessionHeaders = session.cachedHeaders || {};
  const resolvedEmail = session.accountEmail || accountEmail || "";
  return { session, systemPrompt, finalPrompt, nextParentId, sessionHeaders, resolvedEmail };
}

export async function createQwenStreamWithRetry(
  finalPrompt: string,
  isThinkingModel: boolean,
  routedModel: string,
  chatId: string,
  nextParentId: string | null,
  resolvedEmail: string,
): Promise<{ stream: ReadableStream; abortController: AbortController }> {
  try {
    const result = await createQwenStream(finalPrompt, isThinkingModel, routedModel, chatId, nextParentId, resolvedEmail);
    modelRouter.recordSuccess(routedModel);
    return { stream: result.stream, abortController: result.abortController };
  } catch (err: any) {
    modelRouter.recordError(routedModel);
    sessionPool.release(chatId, nextParentId, undefined, resolvedEmail);
    throw err;
  }
}

export function logIncomingRequest(_body: any, _isStream: boolean, _messages: any[]): void {
  // Debug logging intentionally disabled
}
