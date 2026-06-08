import crypto from 'node:crypto';
import type { ParsedToolCall, ToolCallResult, ToolContext } from '../types/openai.ts';
import { SchemaValidationError } from './schema.ts';
import { registry } from './registry.ts';
import { tryExtractToolCall } from './parserHelpers.ts';

const DEFAULT_MAX_CONCURRENCY = 10;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export function parseToolCallsFromContent(content: string): {
  textContent: string;
  toolCalls: ParsedToolCall[];
} {
  const toolCalls: ParsedToolCall[] = [];
  let remaining = content;
  let textContent = '';
  while (true) {
    const result = tryExtractToolCall(remaining);
    textContent += result.textContent;
    remaining = result.remaining;
    if (result.shouldBreak) break;
    if (result.toolCall) toolCalls.push(result.toolCall);
  }
  return { textContent, toolCalls };
}

async function executeSingleTool(
  tc: ParsedToolCall,
  context: ToolContext,
  timeoutMs: number
): Promise<ToolCallResult> {
  if (!registry.has(tc.name)) {
    return { toolCallId: tc.id, name: tc.name, result: JSON.stringify({ error: `Unknown tool: '${tc.name}'` }), isError: true };
  }
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      registry.execute(tc.name, tc.arguments as Record<string, unknown>, context),
      createTimeout(timeoutMs, tc.name, (id) => { timeoutId = id; }),
    ]);
    return { toolCallId: tc.id, name: tc.name, result, isError: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isValidation = err instanceof SchemaValidationError;
    const isTimeout = message.startsWith('Tool execution timed out');
    return {
      toolCallId: tc.id, name: tc.name,
      result: JSON.stringify({
        error: isTimeout ? 'Tool execution timed out' : isValidation ? 'Schema validation failed' : 'Tool execution error',
        details: message,
        ...(isValidation ? { path: (err as SchemaValidationError).path } : {}),
      }),
      isError: true,
    };
  } finally { if (timeoutId !== null) clearTimeout(timeoutId); }
}

function createTimeout(ms: number, toolName: string, onTimerCreated?: (id: ReturnType<typeof setTimeout>) => void): Promise<never> {
  return new Promise((_, reject) => {
    const id = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms for '${toolName}'`)), ms);
    if (onTimerCreated) onTimerCreated(id);
  });
}

export async function executeToolCalls(
  toolCalls: ParsedToolCall[],
  context: ToolContext,
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS
): Promise<ToolCallResult[]> {
  if (toolCalls.length === 0) return [];
  if (toolCalls.length <= maxConcurrency) {
    return await Promise.all(toolCalls.map(tc => executeSingleTool(tc, context, timeoutMs)));
  }
  const results: ToolCallResult[] = Array.from({ length: toolCalls.length });
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < toolCalls.length) {
      const idx = nextIndex++;
      results[idx] = await executeSingleTool(toolCalls[idx], context, timeoutMs);
    }
  }
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(maxConcurrency, toolCalls.length);
  for (let i = 0; i < workerCount; i++) { workers.push(worker()); }
  await Promise.all(workers);
  return results;
}

export function buildToolMessage(result: ToolCallResult): Record<string, unknown> {
  return { role: 'tool', tool_call_id: result.toolCallId, content: result.result };
}

export function buildAssistantToolCallMessage(content: string | null, toolCalls: ParsedToolCall[]): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    role: 'assistant',
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id, type: 'function',
      function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) },
    })),
  };
  if (content) msg.content = content;
  return msg;
}

export function normalizeToolCalls(toolCalls: ParsedToolCall[]): { fixed: ParsedToolCall[] } {
  const fixed: ParsedToolCall[] = [];
  for (const tc of toolCalls) {
    try {
      let args = tc.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args as string); } catch {
          const repaired = repairJson(args as string);
          if (repaired) { try { args = JSON.parse(repaired); } catch { continue; } } else { continue; }
        }
      }
      if (typeof args !== 'object' || Array.isArray(args) || !args) continue;
      const name = tc.name?.trim() || '';
      if (!name) continue;
      fixed.push({ id: tc.id || 'call_' + crypto.randomUUID(), name, arguments: args });
    } catch { continue; }
  }
  return { fixed };
}

function repairJson(raw: string): string | null {
  if (!raw || raw.trim().length < 2) return null;
  let s = raw.trim();

  s = s.replace(/'/g, '"');
  s = s.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
  s = s.replace(/,\s*([}\]])/g, '$1');

  const openCurly = (s.match(/{/g) || []).length;
  const closeCurly = (s.match(/}/g) || []).length;
  const openBracket = (s.match(/\[/g) || []).length;
  const closeBracket = (s.match(/\]/g) || []).length;
  if (openCurly > closeCurly) s += '}'.repeat(openCurly - closeCurly);
  if (openBracket > closeBracket) s += ']'.repeat(openBracket - closeBracket);
  if (closeCurly > openCurly) {
    let excess = closeCurly - openCurly;
    while (excess > 0 && s.endsWith('}')) { s = s.slice(0, -1); excess--; }
  }
  if (closeBracket > openBracket) {
    let excess = closeBracket - openBracket;
    while (excess > 0 && s.endsWith(']')) { s = s.slice(0, -1); excess--; }
  }
  return s !== raw.trim() ? s : null;
}
