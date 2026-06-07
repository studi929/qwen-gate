import { robustParseJSON } from '../utils/json.ts';
import type { ParsedToolCall } from './types.ts';
import { findJsonEnd, normalizeJsonNewlines, looksLikeToolCall, parseToolCall as parseToolCallHelper } from './parserHelpers.ts';

export { findJsonEnd, normalizeJsonNewlines, looksLikeToolCall } from './parserHelpers.ts';

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
  thinking: string;
}
const MAX_BUFFER_SIZE = 65536;
const TRIM_KEEP_CONTEXT = 4096;
export class StreamingToolParser {
  private buffer = '';
  private emittedCount = 0;
  private textEmissionBoundary = 0;
  public passThrough = false;
  feed(chunk: string): ParserResult {
    if (this.passThrough) { this.buffer += chunk; return { text: chunk, toolCalls: [], thinking: '' }; }
    this.buffer += chunk;
    return this.extract();
  }
  private extract(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [], thinking: '' };
    let offset = 0;
    while (offset < this.buffer.length) {
      const nextBraceQuote = this.buffer.indexOf('{"', offset);
      const nextBraceBracket = this.buffer.indexOf('[{', offset);
      let jsonStart = -1;
      let isArray = false;
      if (nextBraceQuote !== -1 && (nextBraceBracket === -1 || nextBraceQuote <= nextBraceBracket)) {
        jsonStart = nextBraceQuote;
      } else if (nextBraceBracket !== -1) { jsonStart = nextBraceBracket; isArray = true; }
      if (jsonStart === -1) {
        if (this.textEmissionBoundary < this.buffer.length) {
          result.text += this.buffer.substring(this.textEmissionBoundary);
          this.textEmissionBoundary = this.buffer.length;
        }
        break;
      }
      if (this.textEmissionBoundary < jsonStart) {
        result.text += this.buffer.substring(this.textEmissionBoundary, jsonStart);
        this.textEmissionBoundary = jsonStart;
      }
      if (isArray) {
        const arrayResult = this.extractArrayToolCalls(jsonStart);
        if (arrayResult) {
          result.toolCalls.push(...arrayResult.toolCalls);
          this.emittedCount += arrayResult.toolCalls.length;
          offset = arrayResult.endOffset;
          this.textEmissionBoundary = offset;
          continue;
        }
        offset = jsonStart + 1;
        continue;
      }
      const after = this.buffer.substring(jsonStart);
      const jsonEnd = findJsonEnd(after);
      if (jsonEnd === -1) { this.textEmissionBoundary = jsonStart; break; }
      const jsonStr = after.substring(0, jsonEnd);
      const normalized = normalizeJsonNewlines(jsonStr);
      if (looksLikeToolCall(jsonStr)) {
        try {
          const parsed = robustParseJSON(normalized);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const tc = parseToolCallHelper(parsed);
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
        } catch { offset = jsonStart + 1; this.textEmissionBoundary = jsonStart; continue; }
      }
      offset = jsonStart + jsonEnd;
      this.textEmissionBoundary = Math.max(this.textEmissionBoundary, offset);
    }
    this.compactBuffer(offset);
    return result;
  }
  private extractArrayToolCalls(startIdx: number): { toolCalls: ParsedToolCall[]; endOffset: number } | null {
    const after = this.buffer.substring(startIdx);
    const arrayEnd = findJsonEnd(after);
    if (arrayEnd === -1) return null;
    const arrayStr = after.substring(0, arrayEnd);
    try {
      const parsed = robustParseJSON(arrayStr);
      if (!Array.isArray(parsed)) return null;
      const toolCalls: ParsedToolCall[] = [];
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          const tc = parseToolCallHelper(item as Record<string, unknown>);
          if (tc) toolCalls.push(tc);
        }
      }
      if (toolCalls.length > 0) return { toolCalls, endOffset: startIdx + arrayEnd };
    } catch { /* Array parse failed */ }
    return null;
  }
  private compactBuffer(offset: number): void {
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
    } else if (offset >= this.buffer.length) { this.buffer = ''; this.textEmissionBoundary = 0; }
  }
  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [], thinking: '' };
    if (this.textEmissionBoundary < this.buffer.length) {
      let remaining = this.buffer.substring(this.textEmissionBoundary);
      while (true) {
        const braceIdx = remaining.indexOf('{');
        if (braceIdx === -1) break;
        const after = remaining.substring(braceIdx);
        const jsonEnd = findJsonEnd(after);
        if (jsonEnd === -1) {
          result.text += remaining.substring(0, braceIdx);
          this.textEmissionBoundary = this.buffer.length;
          remaining = '';
          break;
        }
        const jsonStr = after.substring(0, jsonEnd);
        const normalized = normalizeJsonNewlines(jsonStr);
        if (looksLikeToolCall(jsonStr)) {
          try {
            const parsed = robustParseJSON(normalized);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const tc = parseToolCallHelper(parsed);
              if (tc) {
                result.text += remaining.substring(0, braceIdx);
                result.toolCalls.push(tc);
                this.emittedCount++;
                remaining = remaining.substring(braceIdx + jsonEnd);
                continue;
              }
            }
          } catch { /* Parse failed */ }
          result.text += remaining.substring(0, braceIdx);
          remaining = remaining.substring(braceIdx + jsonEnd);
          continue;
        }
        result.text += remaining.substring(0, braceIdx);
        remaining = remaining.substring(braceIdx + jsonEnd);
      }
      result.text += remaining;
    }
    this.buffer = '';
    this.textEmissionBoundary = 0;
    return result;
  }
  getEmittedToolCallCount(): number { return this.emittedCount; }
}
