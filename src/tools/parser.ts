import type { ParsedToolCall } from './types.ts';

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
  thinking: string;
}

const MAX_BUFFER_SIZE = 65536;
const TRIM_KEEP_CONTEXT = 4096;

const FUNCTION_PREFIX_RE = /^(?:[A-Z][a-z]+\s+[A-Z][a-z]+-|Qwen\s+Core-)/;

function cleanToolName(raw: string): string {
  return raw.replace(FUNCTION_PREFIX_RE, '');
}

export class StreamingToolParser {
  private buffer = '';
  private emittedCount = 0;
  private textEmissionBoundary = 0;
  public passThrough = false;

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
      const nextFunctionXml = this.buffer.indexOf('<function=', offset);
      const nextFunctionCalls = this.buffer.indexOf('<function_calls>', offset);
      const nextSingleXml = this.findNextSingleXmlStart(offset);

      let xmlStart = -1;
      let xmlKind: 'function_eq' | 'function_calls' | 'single' | undefined;

      const candidates: Array<{ idx: number; kind: typeof xmlKind }> = [];
      if (nextFunctionXml !== -1) candidates.push({ idx: nextFunctionXml, kind: 'function_eq' });
      if (nextFunctionCalls !== -1) candidates.push({ idx: nextFunctionCalls, kind: 'function_calls' });
      if (nextSingleXml !== -1) candidates.push({ idx: nextSingleXml, kind: 'single' });
      candidates.sort((a, b) => a.idx - b.idx);

      if (candidates.length > 0) {
        xmlStart = candidates[0].idx;
        xmlKind = candidates[0].kind;
      }

      if (xmlStart === -1) {
        const partialFuncStart = this.findPartialFunctionEqStart();
        if (partialFuncStart !== -1) {
          if (this.textEmissionBoundary < partialFuncStart) {
            result.text += this.buffer.substring(this.textEmissionBoundary, partialFuncStart);
            this.textEmissionBoundary = partialFuncStart;
          }
          break;
        }
        if (this.textEmissionBoundary < this.buffer.length) {
          result.text += this.buffer.substring(this.textEmissionBoundary);
          this.textEmissionBoundary = this.buffer.length;
        }
        break;
      }

      if (this.textEmissionBoundary < xmlStart) {
        result.text += this.buffer.substring(this.textEmissionBoundary, xmlStart);
        this.textEmissionBoundary = xmlStart;
      }

      if (xmlKind === 'function_eq') {
        const xmlResult = this.extractFunctionEqToolCall(xmlStart);
        if (!xmlResult) {
          if (this.textEmissionBoundary < this.buffer.length) {
            result.text += this.buffer.substring(this.textEmissionBoundary, xmlStart);
            this.textEmissionBoundary = xmlStart;
          }
          break;
        }
        result.toolCalls.push(...xmlResult.toolCalls);
        this.emittedCount += xmlResult.toolCalls.length;
        offset = xmlResult.endOffset;
        this.textEmissionBoundary = offset;
        continue;
      }

      if (xmlKind === 'function_calls') {
        const xmlResult = this.extractXmlToolCalls(xmlStart);
        if (!xmlResult) {
          if (this.textEmissionBoundary < this.buffer.length) {
            result.text += this.buffer.substring(this.textEmissionBoundary, xmlStart);
            this.textEmissionBoundary = xmlStart;
          }
          break;
        }
        result.toolCalls.push(...xmlResult.toolCalls);
        this.emittedCount += xmlResult.toolCalls.length;
        offset = xmlResult.endOffset;
        this.textEmissionBoundary = offset;
        continue;
      }

      if (xmlKind === 'single') {
        const xmlResult = this.extractSingleXmlToolCall(xmlStart);
        if (!xmlResult) {
          if (this.textEmissionBoundary < this.buffer.length) {
            result.text += this.buffer.substring(this.textEmissionBoundary, xmlStart);
            this.textEmissionBoundary = xmlStart;
          }
          break;
        }
        result.toolCalls.push(...xmlResult.toolCalls);
        this.emittedCount += xmlResult.toolCalls.length;
        offset = xmlResult.endOffset;
        this.textEmissionBoundary = offset;
        continue;
      }
    }

    this.compactBuffer(offset);
    return result;
  }

  private extractFunctionEqToolCall(startIdx: number): { toolCalls: ParsedToolCall[]; endOffset: number } | null {
    const openMatch = this.buffer.substring(startIdx).match(/^<function=([^>]+)>/);
    if (!openMatch) return null;
    const rawName = openMatch[1];
    const name = cleanToolName(rawName);
    if (!name) return null;
    const openTagLen = openMatch[0].length;
    const closeTag = '</function>';
    const endIdx = this.buffer.indexOf(closeTag, startIdx + openTagLen);
    if (endIdx === -1) return null;
    const endOffset = endIdx + closeTag.length;
    const inner = this.buffer.substring(startIdx + openTagLen, endIdx);
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^\s>]+)>([\s\S]*?)<\/parameter>/g;
    let param: RegExpExecArray | null;
    while ((param = paramRe.exec(inner))) {
      const key = param[1].trim();
      if (!key) continue;
      const rawValue = this.decodeXml(param[2].trim());
      args[key] = /^-?\d+(?:\.\d+)?$/.test(rawValue) ? Number(rawValue) : rawValue;
    }
    return {
      toolCalls: [{ id: `call_${crypto.randomUUID()}`, name, arguments: args }],
      endOffset,
    };
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
    const name = rawTag.toLowerCase();
    if (name === 'toolread') return 'read';
    return name || null;
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

  private findPartialFunctionEqStart(): number {
    const tag = '<function=';
    const max = Math.min(tag.length - 1, this.buffer.length);
    for (let len = max; len > 0; len--) {
      const suffix = this.buffer.substring(this.buffer.length - len);
      if (tag.startsWith(suffix)) return this.buffer.length - len;
    }
    return -1;
  }

  private decodeXml(text: string): string {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
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
    } else if (offset >= this.buffer.length) {
      this.buffer = '';
      this.textEmissionBoundary = 0;
    }
  }

  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [], thinking: '' };
    if (this.textEmissionBoundary < this.buffer.length) {
      const remaining = this.buffer.substring(this.textEmissionBoundary);
      result.text = this.flushStripXmlX(remaining, result);
    }
    this.buffer = '';
    this.textEmissionBoundary = 0;
    return result;
  }

  private flushStripXmlX(text: string, result: ParserResult): string {
    if (!text) return '';
    let pos = 0;
    let clean = '';
    while (pos < text.length) {
      const funcEq = text.indexOf('<function=', pos);
      const funcCalls = text.indexOf('<function_calls>', pos);
      const single = this.findNextSingleXmlStart(pos);
      let nextXml = -1;
      let kind: 'fe' | 'fc' | 's' | undefined;
      const cand: { idx: number; k: typeof kind }[] = [];
      if (funcEq !== -1) cand.push({ idx: funcEq, k: 'fe' });
      if (funcCalls !== -1) cand.push({ idx: funcCalls, k: 'fc' });
      if (single !== -1) cand.push({ idx: single, k: 's' });
      cand.sort((a, b) => a.idx - b.idx);
      if (cand.length) { nextXml = cand[0].idx; kind = cand[0].k; }
      if (nextXml === -1) { clean += text.substring(pos); break; }
      if (nextXml > pos) clean += text.substring(pos, nextXml);
      let tc: { toolCalls: ParsedToolCall[]; endOffset: number } | null = null;
      if (kind === 'fe') tc = this.extractFunctionEqToolCall(nextXml);
      else if (kind === 'fc') tc = this.extractXmlToolCalls(nextXml);
      else if (kind === 's') tc = this.extractSingleXmlToolCall(nextXml);
      if (tc) {
        result.toolCalls.push(...tc.toolCalls);
        this.emittedCount += tc.toolCalls.length;
        pos = tc.endOffset;
      } else if (kind === 'fe') {
        const c = text.indexOf('</function>', nextXml + 1);
        pos = c !== -1 ? c + '</function>'.length : text.length;
      } else if (kind === 'fc') {
        const c = text.indexOf('</function_calls>', nextXml + 1);
        pos = c !== -1 ? c + '</function_calls>'.length : text.length;
      } else if (kind === 's') {
        const open = text.substring(nextXml).match(/^<([A-Za-z][A-Za-z0-9_]*)>/);
        if (open) {
          const ct = `</${open[1]}>`;
          const c = text.indexOf(ct, nextXml + open[0].length);
          pos = c !== -1 ? c + ct.length : text.length;
        } else { pos = nextXml + 1; }
      }
    }
    return clean;
  }

  getEmittedToolCallCount(): number { return this.emittedCount; }
}
