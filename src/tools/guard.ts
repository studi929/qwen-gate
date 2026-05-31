import type { ParsedToolCall } from './types.ts';

export interface GuardResult {
  valid: ParsedToolCall[];
  errors: string[];
  correctionPrompt: string;
  ok: boolean;
}

export interface ProviderToolLeakResult {
  detected: boolean;
  reason?: string;
  type?: string;
}

function validateSingleTC(tc: ParsedToolCall): string[] {
  const errors: string[] = [];
  if (!tc.name || typeof tc.name !== 'string' || tc.name.trim() === '') {
    errors.push('Tool call missing or has invalid "name" field.');
  }
  if (tc.arguments === undefined || tc.arguments === null) {
    errors.push(`Tool call "${tc.name}" missing "arguments" field.`);
  } else if (typeof tc.arguments !== 'object') {
    errors.push(`Tool call "${tc.name}" has non-object arguments.`);
  }
  return errors;
}

export function validateToolCalls(toolCalls: ParsedToolCall[]): GuardResult {
  const errors: string[] = [];
  const valid: ParsedToolCall[] = [];

  if (!Array.isArray(toolCalls)) {
    errors.push('Tool calls must be an array.');
    return { valid: [], errors, correctionPrompt: '', ok: false };
  }

  for (const tc of toolCalls) {
    const tcErrors = validateSingleTC(tc);
    if (tcErrors.length === 0) {
      valid.push({ ...tc, name: tc.name.trim() });
    } else {
      errors.push(...tcErrors);
    }
  }

  const correctionPrompt = errors.length > 0 ? buildCorrectionPrompt(errors) : '';
  return {
    valid: errors.length === 0 ? valid : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  };
}

export function validateSingleToolCall(tc: ParsedToolCall): GuardResult {
  const errors = validateSingleTC(tc);
  const correctionPrompt = errors.length > 0 ? buildCorrectionPrompt(errors) : '';
  return {
    valid: errors.length === 0 ? [tc] : [],
    errors,
    correctionPrompt,
    ok: errors.length === 0,
  };
}

export function buildCorrectionPrompt(errors: string[]): string {
  if (errors.length === 0) return '';
  if (errors.length === 1) return `Fix: ${errors[0]}`;
  if (errors.length <= 3) return `Fix: ${errors.join('; ')}`;
  return `Fix: ${errors.slice(0, 3).join('; ')} and ${errors.length - 3} more.`;
}

export function detectProviderToolLeak(content: string): ProviderToolLeakResult {
  if (/function_call.*role/i.test(content)) return { detected: true, type: 'function_role' };
  if (/tool_calls.*role/i.test(content)) return { detected: true, type: 'tool_call_role' };
  if (/<tool_use>/i.test(content)) return { detected: true, type: 'tool_use_xml' };
  return { detected: false };
}

/**
 * Serialize tool arguments to a stable string key for comparison.
 * Sorts object keys to ensure consistent serialization regardless of order.
 */
function serializeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const parts = keys.map(k => `${k}:${JSON.stringify(args[k])}`);
  return parts.join('|');
}

/**
 * Detect loop: same tool called with identical arguments N times.
 * A "loop" means the model is stuck calling the same tool with the same
 * inputs — a sign it's not processing results and moving forward.
 *
 * @param toolCall       The current parsed tool call
 * @param recentHistory  Array of { name, args } from prior tool calls
 * @param maxRepeats     How many repeats before flagging (default 4)
 * @returns GuardResult — if loop detected, ok=false with description
 */
export function detectToolCallLoop(
  toolCall: ParsedToolCall,
  recentHistory: { name: string; args: Record<string, unknown> }[],
  maxRepeats = 4,
): GuardResult {
  const recentSerialized = recentHistory.map(h => `${h.name}::${serializeArgs(h.args)}`);
  const currentSerialized = `${toolCall.name}::${serializeArgs(toolCall.arguments)}`;

  let repeatCount = 0;
  for (const entry of recentSerialized) {
    if (entry === currentSerialized) repeatCount++;
  }

  if (repeatCount >= maxRepeats) {
    const msg = `Loop detected: "${toolCall.name}" called with identical arguments ${repeatCount + 1} times. Stop repeating this call.`;
    return {
      valid: [],
      errors: [msg],
      correctionPrompt: msg,
      ok: false,
    };
  }

  return { valid: [toolCall], errors: [], correctionPrompt: '', ok: true };
}

/**
 * Detect parallel tool call loops: multiple identical tool calls within the
 * same response (same name + same arguments array). This catches models that
 * generate the same tool call N times in parallel.
 */
export function detectParallelToolLoop(toolCalls: ParsedToolCall[]): GuardResult {
  if (toolCalls.length < 2) {
    return { valid: toolCalls, errors: [], correctionPrompt: '', ok: true };
  }

  const seen = new Map<string, number[]>();
  for (let i = 0; i < toolCalls.length; i++) {
    const key = `${toolCalls[i].name}::${serializeArgs(toolCalls[i].arguments)}`;
    const indices = seen.get(key) || [];
    indices.push(i);
    seen.set(key, indices);
  }

  for (const [key, indices] of seen) {
    if (indices.length >= 3) {
      const [name] = key.split('::');
      const msg = `Parallel loop detected: "${name}" called ${indices.length} times with identical arguments in the same response. Only call each distinct tool+args once.`;
      const valid = toolCalls.filter((_, i) => !indices.includes(i));
      return {
        valid,
        errors: [msg],
        correctionPrompt: `Fix: Do not call "${name}" multiple times with the same arguments. Call each tool once.`,
        ok: false,
      };
    }
  }

  return { valid: toolCalls, errors: [], correctionPrompt: '', ok: true };
}
