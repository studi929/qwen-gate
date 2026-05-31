/*
 * File: parser.ts
 * Project: qwen-gate
 * Streaming JSON tool call parser.
 * Extracts {"name": ..., "arguments": {...}} from streaming text chunks.
 * Strips markdown fences and XML wrapper tags automatically.
 * Tracks emission boundaries to avoid re-emitting text on cumulative streams.
 *
 * Handles:
 * - Partial JSON across chunks
 * - Nested objects/arrays in arguments
 * - Unicode and escape sequences
 * - Multiple tool calls in sequence
 * - Array-wrapped tool calls: [{"name":...}, {"name":...}]
 * - Think/thinking blocks
 * - Malformed JSON with graceful recovery
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/json.ts';
import type { ParsedToolCall } from './types.ts';

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
  thinking: string;
}

/** Maximum buffer size before trimming (64KB) */
const MAX_BUFFER_SIZE = 65536;
/** How much context to keep when trimming buffer */
const TRIM_KEEP_CONTEXT = 4096;

export class StreamingToolParser {
  private buffer = '';
  private emittedCount = 0;
  /** Track how far into the buffer we've emitted as text. */
  private textEmissionBoundary = 0;

  public passThrough = false;
  public skipPreProcess = false;

  feed(chunk: string): ParserResult {
    if (this.passThrough) {
      this.buffer += chunk;
      return { text: chunk, toolCalls: [], thinking: '' };
    }

    this.buffer += chunk;
    return this.extract();
  }

  private extract(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [], thinking: '' };
    let offset = 0;

    while (offset < this.buffer.length) {
      // ── Look for JSON objects ──────────────────────────────────────────
      const nextBraceQuote = this.buffer.indexOf('{"', offset);
      const nextBraceBracket = this.buffer.indexOf('[{', offset);

      // Determine which comes first
      let jsonStart = -1;
      let isArray = false;

      if (nextBraceQuote !== -1 && (nextBraceBracket === -1 || nextBraceQuote <= nextBraceBracket)) {
        jsonStart = nextBraceQuote;
      } else if (nextBraceBracket !== -1) {
        jsonStart = nextBraceBracket;
        isArray = true;
      }

      if (jsonStart === -1) {
        // No more JSON-like structures — emit remaining text
        if (this.textEmissionBoundary < this.buffer.length) {
          result.text += this.buffer.substring(this.textEmissionBoundary);
          this.textEmissionBoundary = this.buffer.length;
        }
        break;
      }

      // Check if there's text before the JSON to emit
      if (this.textEmissionBoundary < jsonStart) {
        result.text += this.buffer.substring(this.textEmissionBoundary, jsonStart);
        this.textEmissionBoundary = jsonStart;
      }

      if (isArray) {
        const arrayResult = this.extractArrayToolCalls(jsonStart);
        if (arrayResult) {
          const extracted = arrayResult.toolCalls;
          result.toolCalls.push(...extracted);
          this.emittedCount += extracted.length;
          offset = arrayResult.endOffset;
          this.textEmissionBoundary = offset;
          continue;
        }
        // Array didn't parse — advance past the bracket
        offset = jsonStart + 1;
        continue;
      }

      const after = this.buffer.substring(jsonStart);
      const jsonEnd = this.findJsonEnd(after);

      if (jsonEnd === -1) {
        this.textEmissionBoundary = jsonStart;
        break;
      }

      const jsonStr = after.substring(0, jsonEnd);
      const normalized = this.normalizeJsonNewlines(jsonStr);

      if (this.looksLikeToolCall(jsonStr)) {
        try {
          const parsed = robustParseJSON(normalized);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const tc = this.parseToolCall(parsed);
            if (tc) {
              result.toolCalls.push(tc);
              this.emittedCount++;
              offset = jsonStart + jsonEnd;
              this.textEmissionBoundary = offset;
              continue;
            }
          }
          offset = jsonStart + jsonEnd;
          this.textEmissionBoundary = Math.max(this.textEmissionBoundary, offset);
          continue;
        } catch {
          offset = jsonStart + 1;
          this.textEmissionBoundary = jsonStart;
          continue;
        }
      }

      offset = jsonStart + jsonEnd;
      this.textEmissionBoundary = Math.max(this.textEmissionBoundary, offset);
      continue;
    }

    // ── Buffer management ───────────────────────────────────────────────
    this.compactBuffer(offset);
    return result;
  }

  /**
   * Try to extract a <think>...</think> or <thinking>...</thinking> block
   * starting from the given offset.
   */
  private extractThinkBlock(offset: number): { content: string; endOffset: number } | null {
    for (const tagName of ['think', 'thinking']) {
      const openTag = `<${tagName}>`;
      const closeTag = `</${tagName}>`;

      if (this.buffer.startsWith(openTag, offset)) {
        const endIdx = this.buffer.indexOf(closeTag, offset + openTag.length);
        if (endIdx !== -1) {
          return {
            content: this.buffer.substring(offset + openTag.length, endIdx),
            endOffset: endIdx + closeTag.length,
          };
        }
      }
    }
    return null;
  }

  /**
   * Check if there's a partial <think or <thinking tag at the current position
   * that we should wait for more data on.
   */
  private hasIncompleteThinkTag(offset: number): boolean {
    const remaining = this.buffer.substring(offset);
    for (const tagName of ['think', 'thinking']) {
      const openTag = `<${tagName}>`;
      if (remaining.length < openTag.length && openTag.startsWith(remaining)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Try to extract multiple tool calls from an array: [{"name":...}, {"name":...}]
   */
  private extractArrayToolCalls(startIdx: number): { toolCalls: ParsedToolCall[]; endOffset: number } | null {
    const after = this.buffer.substring(startIdx);
    const arrayEnd = this.findJsonEnd(after);
    if (arrayEnd === -1) return null; // Incomplete array

    const arrayStr = after.substring(0, arrayEnd);
    try {
      const parsed = robustParseJSON(arrayStr);
      if (!Array.isArray(parsed)) return null;

      const toolCalls: ParsedToolCall[] = [];
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          const tc = this.parseToolCall(item);
          if (tc) toolCalls.push(tc);
        }
      }

      if (toolCalls.length > 0) {
        return { toolCalls, endOffset: startIdx + arrayEnd };
      }
    } catch {
      // Array parse failed
    }
    return null;
  }

  /**
   * Quick heuristic: does this JSON string look like it contains a tool call?
   * Matches field names with optional whitespace/newlines between the quote
   * and the field name — handles streaming chunks where newlines split
   * inside JSON keys like "\narguments" or "param\neters".
   */
  private looksLikeToolCall(jsonStr: string): boolean {
    // Collapse whitespace for key-name matching. This normalizes embedded
    // newlines inside keys (e.g., "\narguments" → " arguments") while
    // preserving the structure for full parsing later.
    const norm = jsonStr.replace(/\s+/g, '');
    return norm.includes('"name"') && (
      norm.includes('"arguments"') ||
      norm.includes('"function"') ||
      norm.includes('"parameters"')
    );
  }

  /**
   * Normalize literal newlines/tabs/carriage-returns inside JSON string
   * values to their escaped forms (\\n / \\t / \\r).
   *
   * Streaming chunks may split newlines inside JSON strings. JSON.parse
   * rejects literal control characters inside strings, so we pre-escape
   * them before any JSON parsing attempt.
   *
   * Correctly handles:
   * - \" escape sequences (backslash preserves the string-open state)
   * - \\\\ escape sequences (backslash-backslash)
   * - Literal \\n/\\r/\\t bytes inside strings
   */
  private normalizeJsonNewlines(raw: string): string {
    let result = '';
    let inString = false;

    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];

      if (inString) {
        if (c === '\\') {
          // Skip the next character — it's part of an escape sequence
          result += c;
          i++;
          if (i < raw.length) result += raw[i];
          continue;
        }
        if (c === '"') {
          inString = false;
          result += c;
          continue;
        }
        // Strip literal control characters invalid in JSON strings.
        // Streaming fragments can split newlines inside string literals.
        // Stripping (rather than escaping) ensures parsed keys like
        // "\nname" correctly resolve to "name" instead of "\\nname".
        if (c === '\n' || c === '\r' || c === '\t') { continue; }
        result += c;
      } else {
        if (c === '"') inString = true;
        result += c;
      }
    }

    return result;
  }

  /**
   * Find the end of a balanced JSON structure (object or array)
   * starting from the first { or [ in the string.
   * Returns the index after the closing bracket, or -1 if incomplete.
   *
   * Correctly handles:
   * - Nested objects and arrays
   * - String literals with escape sequences
   * - Unicode escape sequences (\uXXXX)
   * - Surrogate pairs
   */
  private findJsonEnd(buf: string): number {
    let i = 0;
    // Skip leading whitespace
    while (i < buf.length && ' \t\n\r'.includes(buf[i])) i++;
    if (i >= buf.length) return -1;

    const startChar = buf[i];
    if (startChar !== '{' && startChar !== '[') return -1;

    let depth = 0;
    let inString = false;

    for (; i < buf.length; i++) {
      const c = buf[i];

      if (inString) {
        if (c === '\\') {
          // Skip escape sequence
          i++;
          if (i >= buf.length) return -1;
          if (buf[i] === 'u') {
            // Need 4 hex digits
            if (i + 4 >= buf.length) return -1;
            i += 4; // Skip the 4 hex digits (loop will i++ past the last one)
          }
          continue;
        }
        if (c === '"') {
          inString = false;
        }
        continue;
      }

      switch (c) {
        case '"':
          inString = true;
          break;
        case '{':
        case '[':
          depth++;
          break;
        case '}':
        case ']':
          depth--;
          if (depth === 0) return i + 1;
          break;
      }
    }

    return -1; // Unbalanced
  }

  /**
   * Parse a JSON object into a ParsedToolCall.
   * Handles multiple formats:
   * - {"name": "tool", "arguments": {...}}
   * - {"name": "tool", "arguments": "{...}"}  (stringified args)
   * - {"function": {"name": "tool", "arguments": "..."}}
   * - {"name": "tool", "parameters": {...}}
   */
  private parseToolCall(parsed: Record<string, unknown>): ParsedToolCall | null {
    // Try direct format first
    let name = parsed.name;
    let args = parsed.arguments ?? parsed.parameters;

    // Try nested function format
    if (!name && parsed.function && typeof parsed.function === 'object') {
      const fn = parsed.function as Record<string, unknown>;
      name = fn.name;
      args = args ?? fn.arguments ?? fn.parameters;
    }

    if (!name || typeof name !== 'string') return null;
    const trimmedName = name.trim();
    if (!trimmedName) return null;

    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }

    // Ensure args is a plain object
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      // If no arguments field but there are extra keys, use them as arguments
      if (args === undefined || args === null) {
        const { name: _n, function: _f, ...rest } = parsed;
        args = Object.keys(rest).length > 0 ? rest : {};
      } else {
        args = {};
      }
    }

    return {
      id: `call_${uuidv4()}`,
      name: trimmedName,
      arguments: args as Record<string, unknown>,
    };
  }

  /**
   * Compact the buffer by removing already-processed content.
   * Keeps context around the boundary for lookback operations.
   */
  private compactBuffer(offset: number): void {
    // Only compact if buffer exceeds threshold
    if (this.textEmissionBoundary > MAX_BUFFER_SIZE) {
      const trimPoint = this.textEmissionBoundary - TRIM_KEEP_CONTEXT;
      this.buffer = this.buffer.substring(trimPoint);
      const trimDelta = trimPoint;
      this.textEmissionBoundary = TRIM_KEEP_CONTEXT;
      offset -= trimDelta;
    }

    if (offset > 0 && offset < this.buffer.length) {
      this.buffer = this.buffer.substring(offset);
      this.textEmissionBoundary -= offset;
      if (this.textEmissionBoundary < 0) this.textEmissionBoundary = 0;
    } else if (offset >= this.buffer.length) {
      this.buffer = '';
      this.textEmissionBoundary = 0;
    }
  }

  /**
   * Flush any remaining buffered content.
   * Called when the stream ends to ensure no data is lost.
   */
  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [], thinking: '' };

    if (this.textEmissionBoundary < this.buffer.length) {
      let remaining = this.buffer.substring(this.textEmissionBoundary);

      // Try one final pass to extract tool calls from remaining buffer
      while (true) {

        const braceIdx = remaining.indexOf('{');
        if (braceIdx === -1) break;

        const after = remaining.substring(braceIdx);
        const jsonEnd = this.findJsonEnd(after);
        if (jsonEnd === -1) {
          // Incomplete JSON at end of stream — emit text before it, drop the JSON fragment
          result.text += remaining.substring(0, braceIdx);
          this.textEmissionBoundary = this.buffer.length;
          remaining = '';
          break;
        }

        const jsonStr = after.substring(0, jsonEnd);
        const normalized = this.normalizeJsonNewlines(jsonStr);
        if (this.looksLikeToolCall(jsonStr)) {
          try {
            const parsed = robustParseJSON(normalized);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const tc = this.parseToolCall(parsed);
              if (tc) {
                result.text += remaining.substring(0, braceIdx);
                result.toolCalls.push(tc);
                this.emittedCount++;
                remaining = remaining.substring(braceIdx + jsonEnd);
                continue;
              }
            }
          } catch {
            // Parse failed — skip JSON to prevent it leaking as text
          }
          // Failed to parse as tool call — skip the JSON entirely (don't emit as text)
          result.text += remaining.substring(0, braceIdx);
          remaining = remaining.substring(braceIdx + jsonEnd);
          continue;
        }

        // Not a tool call — skip past this JSON
        result.text += remaining.substring(0, braceIdx);
        remaining = remaining.substring(braceIdx + jsonEnd);
      }

      result.text += remaining;
    }

    this.buffer = '';
    this.emittedCount = 0;
    this.textEmissionBoundary = 0;

    return result;
  }

  getEmittedToolCallCount(): number {
    return this.emittedCount;
  }
}
