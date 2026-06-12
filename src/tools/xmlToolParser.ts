import crypto from 'node:crypto';

export interface ParsedXmlToolCall {
  name: string;
  parameters: Record<string, string>;
}

function functionNameFromTag(tag: string): string | null {
  // Match function name from <function=NAME...> — NAME can be any non-whitespace, non-> chars
  const m = tag.match(/^<function=([^\s>]+)>/);
  return m ? m[1] : null;
}

export function parseXmlToolCalls(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const toolCalls: ParsedXmlToolCall[] = [];
  const unique = new Set<string>();
  let cleanedText = text;

  const re = /<function=[^\s>]+[\s\S]*?>[\s\S]*?(?:<\/function>|$)/g;
  const sections: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (unique.has(match[0])) continue;
    unique.add(match[0]);

    const name = functionNameFromTag(match[0]);
    if (!name) continue;

    const closingTag = '</function>';
    const closingIndex = match[0].lastIndexOf(closingTag);
    if (closingIndex === -1) continue; // malformed — no closing tag
    const body = match[0].slice(match[0].indexOf('>') + 1, closingIndex);

    const parameters: Record<string, string> = {};
    const paramRe = /<parameter=([^\s>]+)>([\s\S]*?)<\/parameter>/g;
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

  return { toolCalls, cleanedText: cleanedText.replace(/\n{4,}/g, '\n\n\n').trim() };
}

/**
 * Pre-compiled regexes for stripping remaining XML markup.
 * Grouped into 3 passes (down from 10 individual .replace() calls)
 * to reduce regex engine invocations on the full content buffer.
 */
// Pass 1: All function-related markup — complete blocks, bare tags, fragments, closing tags
const FUNCTION_MARKUP_RE = /<function=[^\s>][^>]*>[\s\S]*?(?:<\/function>|<function=|$)|<function=[^>]*(?:>|(?=\n|$))|<function(?=[\s<]|$)|<\/?function>/g;
// Pass 2: All parameter-related markup — complete blocks, bare tags, closing tags
const PARAMETER_MARKUP_RE = /<parameter=[^\s>][^>]*>[\s\S]*?<\/parameter>|<parameter=[^>]*(?:>|(?=\n|$))|<\/?parameter>/g;
// Pass 3: Excessive newlines
const EXCESS_NEWLINES_RE = /\n{4,}/g;

function stripRemainingXmlMarkup(text: string): string {
  return text
    .replace(FUNCTION_MARKUP_RE, '')
    .replace(PARAMETER_MARKUP_RE, '')
    .replace(EXCESS_NEWLINES_RE, '\n\n\n')
    .trim();
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
