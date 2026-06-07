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
const XML_TOOL_TAGS = ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'task', 'question', 'webfetch', 'skill', 'todowrite'];
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
      const nextFunctionCalls = this.buffer.indexOf('<function_calls>', offset);
      const nextSingleXml = this.findNextSingleXmlStart(offset);
      let jsonStart = -1;
      let isArray = false;
      if (nextBraceQuote !== -1 && (nextBraceBracket === -1 || nextBraceQuote <= nextBraceBracket)) {
        jsonStart = nextBraceQuote;
      } else if (nextBraceBracket !== -1) { jsonStart = nextBraceBracket; isArray = true; }
      const nextXmlStart = this.firstIndex(nextFunctionCalls, nextSingleXml);
      if (nextXmlStart !== -1 && (jsonStart === -1 || nextXmlStart < jsonStart)) {
        if (nextXmlStart === nextSingleXml) {
          if (this.textEmissionBoundary < nextSingleXml) {
            result.text += this.buffer.substring(this.textEmissionBoundary, nextSingleXml);
            this.textEmissionBoundary = nextSingleXml;
          }
          const xmlResult = this.extractSingleXmlToolCall(nextSingleXml);
          if (!xmlResult) { break; }
          result.toolCalls.push(...xmlResult.toolCalls);
          this.emittedCount += xmlResult.toolCalls.length;
          offset = xmlResult.endOffset;
          this.textEmissionBoundary = offset;
          continue;
        }
        if (this.textEmissionBoundary < nextFunctionCalls) {
          result.text += this.buffer.substring(this.textEmissionBoundary, nextFunctionCalls);
          this.textEmissionBoundary = nextFunctionCalls;
        }
        const xmlResult = this.extractXmlToolCalls(nextFunctionCalls);
        if (!xmlResult) { break; }
        result.toolCalls.push(...xmlResult.toolCalls);
        this.emittedCount += xmlResult.toolCalls.length;
        offset = xmlResult.endOffset;
        this.textEmissionBoundary = offset;
        continue;
      }
      if (jsonStart === -1) {
        const partialXmlStart = this.findPartialXmlStart();
        if (partialXmlStart !== -1) {
          if (this.textEmissionBoundary < partialXmlStart) {
            result.text += this.buffer.substring(this.textEmissionBoundary, partialXmlStart);
            this.textEmissionBoundary = partialXmlStart;
          }
          break;
        }
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
  private extractXmlToolCalls(startIdx: number): { toolCalls: ParsedToolCall[]; endOffset: number } | null {
    const closeTag = '</function_calls>';
    const endIdx = this.buffer.indexOf(closeTag, startIdx);
    if (endIdx === -1) return null;
    const endOffset = endIdx + closeTag.length;
    const block = this.buffer.substring(startIdx, endOffset);
    const toolCalls: ParsedToolCall[] = [];
    const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
    let match: RegExpExecArray | null;
    while ((match = invokeRe.exec(block))) {
      const name = match[1].trim();
      if (!name) continue;
      const args: Record<string, unknown> = {};
      const params = match[2];
      const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
      let param: RegExpExecArray | null;
      while ((param = paramRe.exec(params))) {
        const key = param[1].trim();
        if (!key) continue;
        const rawValue = this.decodeXml(param[2].trim());
        args[key] = /^-?\d+(?:\.\d+)?$/.test(rawValue) ? Number(rawValue) : rawValue;
      }
      toolCalls.push({ id: `call_${crypto.randomUUID()}`, name, arguments: args });
    }
    return { toolCalls, endOffset };
  }
  private extractSingleXmlToolCall(startIdx: number): { toolCalls: ParsedToolCall[]; endOffset: number } | null {
    const open = this.buffer.substring(startIdx).match(/^<([A-Za-z][A-Za-z0-9_]*)>/);
    if (!open) return null;
    const rawTag = open[1];
    const name = this.xmlToolName(rawTag);
    if (!name) return null;
    const closeTag = `</${rawTag}>`;
    const endIdx = this.buffer.indexOf(closeTag, startIdx + open[0].length);
    if (endIdx === -1) return null;
    const endOffset = endIdx + closeTag.length;
    const inner = this.buffer.substring(startIdx + open[0].length, endIdx);
    const args: Record<string, unknown> = {};
    const paramRe = /<(?:parameter|param)\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:parameter|param)>/g;
    let param: RegExpExecArray | null;
    while ((param = paramRe.exec(inner))) {
      const key = param[1].trim();
      if (!key) continue;
      const rawValue = this.decodeXml(param[2].trim());
      args[key] = /^-?\d+(?:\.\d+)?$/.test(rawValue) ? Number(rawValue) : rawValue;
    }
    return { toolCalls: [{ id: `call_${crypto.randomUUID()}`, name, arguments: args }], endOffset };
  }
  private xmlToolName(rawTag: string): string | null {
    if (/^ToolRead$/i.test(rawTag)) return 'read';
    const lower = rawTag.toLowerCase();
    return XML_TOOL_TAGS.includes(lower) ? lower : null;
  }
  private findNextSingleXmlStart(offset: number): number {
    const re = /<([A-Za-z][A-Za-z0-9_]*)>/g;
    re.lastIndex = offset;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.buffer))) {
      if (this.xmlToolName(match[1])) return match.index;
    }
    return -1;
  }
  private firstIndex(a: number, b: number): number {
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  }
  private decodeXml(text: string): string {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  private findPartialXmlStart(): number {
    const tag = '<function_calls>';
    const max = Math.min(tag.length - 1, this.buffer.length);
    for (let len = max; len > 0; len--) {
      const suffix = this.buffer.substring(this.buffer.length - len);
      if (tag.startsWith(suffix)) return this.buffer.length - len;
    }
    return -1;
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
