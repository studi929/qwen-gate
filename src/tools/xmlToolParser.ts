import crypto from 'node:crypto';
import { TOOL_CALL_KEYWORDS } from '../utils/tagNames.ts';

export interface ParsedXmlToolCall {
  name: string;
  parameters: Record<string, string>;
}

function functionNameFromTag(tag: string): string | null {
  // Match function name from <KEYWORD=NAME...> — NAME can be any non-whitespace, non-> chars
  const kw = TOOL_CALL_KEYWORDS[0];
  const m = tag.match(new RegExp(`^<${kw}=([^\\s>]+)>`));
  return m ? m[1] : null;
}

export function parseXmlToolCalls(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const toolCalls: ParsedXmlToolCall[] = [];
  const unique = new Set<string>();
  let cleanedText = text;

  // Fast path: skip the expensive regex exec loop when there's no tool call content
  const hasToolCallStart = TOOL_CALL_KEYWORDS.some(kw => text.includes(`<${kw}=`));
  if (!hasToolCallStart) return { toolCalls, cleanedText };

  const fkw = TOOL_CALL_KEYWORDS[0]; // 'function' — the block-level keyword
  const pkw = TOOL_CALL_KEYWORDS[1]; // 'parameter' — the parameter keyword
  // Semantics: <keyword=NAME...chars...> body </keyword>
  // Matches the opening <keyword=, captures until first >, then lazily until </keyword> or end.
  const re = new RegExp(`<${fkw}=[^\\s>]+[\\s\\S]*?>[\\s\\S]*?(?:<\\/${fkw}>|$)`, 'g');
  const sections: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (unique.has(match[0])) continue;
    unique.add(match[0]);

    const name = functionNameFromTag(match[0]);
    if (!name) continue;

    const closingTag = `</${fkw}>`;
    const closingIndex = match[0].lastIndexOf(closingTag);
    if (closingIndex === -1) continue; // malformed — no closing tag
    const body = match[0].slice(match[0].indexOf('>') + 1, closingIndex);

    const parameters: Record<string, string> = {};
    const paramRe = new RegExp(`<${pkw}=([^\\s>]+)>([\\s\\S]*?)<\\/${pkw}>`, 'g');
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(body)) !== null) {
      parameters[pm[1].trim()] = pm[2].trim();
    }

    toolCalls.push({ name, parameters });
    sections.push(text.slice(lastIdx, match.index));
    lastIdx = re.lastIndex;
  }

  sections.push(text.slice(lastIdx));
  cleanedText = sections.join('');

  return { toolCalls, cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n') };
}

/**
 * Pre-compiled regexes for stripping remaining XML markup.
 * Built dynamically from the shared TOOL_CALL_KEYWORDS array so adding
 * new tool call tag keywords is a one-line change.
 */
const [TOOL_MARKUP_RE, EXCESS_NEWLINES_RE] = (() => {
  const markupParts: string[] = [];
  for (const kw of TOOL_CALL_KEYWORDS) {
    // 1. Complete block (or truncated at next occurrence of same keyword)
    markupParts.push(`<${kw}=[^\\s>][^>]*>[\\s\\S]*?(?:<\\/${kw}>|<${kw}=|$)`);
    // 2. Bare tag with =value (no >, or > at end)
    markupParts.push(`<${kw}=[^>]*(?:>|(?=\\n|$))`);
    // 3. Bare <keyword prefix followed by whitespace, <, or end
    markupParts.push(`<${kw}(?=[\\s<]|$)`);
    // 4. Opening/closing tag
    markupParts.push(`<\\/?${kw}>`);
  }
  return [
    new RegExp(markupParts.join('|'), 'g'),
    /\n{3,}/g,
  ];
})();

function stripRemainingXmlMarkup(text: string): string {
  return text
    .replace(TOOL_MARKUP_RE, '')
    .replace(EXCESS_NEWLINES_RE, '\n\n');
}

export function cleanTextOfXmlArtifacts(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const { toolCalls, cleanedText } = parseXmlToolCalls(text);
  const fullyCleaned = stripRemainingXmlMarkup(cleanedText);
  return { toolCalls, cleanedText: fullyCleaned };
}

export function xmlToolCallToParsed(block: ParsedXmlToolCall, _index: number): { id: string; name: string; arguments: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.parameters)) {
    try { args[key] = JSON.parse(value); } catch { args[key] = value; }
  }
  const rawName = block.name;
  const name = rawName.startsWith("★-") ? rawName.slice(2) : rawName;
  return {
    id: `call_${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
}
