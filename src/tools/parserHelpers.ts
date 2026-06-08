import crypto from 'node:crypto';
import type { ParsedToolCall } from '../types/openai.ts';
import { robustParseJSON } from '../utils/json.ts';

export interface ExtractResult {
  textContent: string;
  toolCall: ParsedToolCall | null;
  remaining: string;
  shouldBreak: boolean;
}

export function findBalancedJsonEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

export function tryExtractToolCall(remaining: string): ExtractResult {
  const nameIdx = remaining.indexOf('"name"');
  if (nameIdx === -1) {
    return { textContent: remaining, toolCall: null, remaining: '', shouldBreak: true };
  }
  const searchFrom = Math.max(0, nameIdx - 300);
  const braceIdx = remaining.lastIndexOf('{', nameIdx);
  if (braceIdx === -1 || braceIdx < searchFrom) {
    return { textContent: remaining[0] || '', toolCall: null, remaining: remaining.substring(1), shouldBreak: false };
  }
  const textContent = braceIdx > 0 ? remaining.substring(0, braceIdx) : '';
  const after = remaining.substring(braceIdx);
  const jsonEnd = findBalancedJsonEnd(after);
  if (jsonEnd === -1) {
    return { textContent: remaining, toolCall: null, remaining: '', shouldBreak: true };
  }
  const jsonStr = after.substring(0, jsonEnd);
  try {
    const parsed = robustParseJSON(jsonStr);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON');
    let args = parsed.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (typeof args !== 'object' || Array.isArray(args)) args = {};
    const rawName = parsed.name || '';
    const name = rawName.startsWith("★-") ? rawName.slice(2) : rawName;
    const toolCall: ParsedToolCall = {
      id: 'call_' + crypto.randomUUID(),
      name,
      arguments: args || {},
    };
    return { textContent, toolCall, remaining: after.substring(jsonEnd), shouldBreak: false };
  } catch {
    return { textContent: jsonStr, toolCall: null, remaining: after.substring(jsonEnd), shouldBreak: false };
  }
}
