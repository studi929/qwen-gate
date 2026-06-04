const TOOL_ECHO_PATTERNS: RegExp[] = [
  /\bI(?:'ll|\s+will|\s+shall|\s+can|\s+need\s+to)\s+(?:use|run|call|invoke|execute|try)\s+(?:the\s+)?[a-z_]+(?:\.\w+)?\s+(?:tool|command|function|utility)/i,
  /\bUsing\s+(?:the\s+)?[a-z_]+(?:\.\w+)?\s+(?:tool|command|function|utility)\s+(?:to|for|I)/i,
  /\b[Tt]he\s+[a-z_]+(?:\.\w+)?\s+(?:tool|command|function|utility)\s+(?:returned|shows?|produced|found|gave|output(?:ted)?|contained|has|displays?)/i,
  /\b[Tt]ool\s+[a-z_]+(?:\.\w+)?\s+(?:result|output|response|returned|shows?|found|gave|produced)\s*[:.]/i,
  /\b(?:result|output|response)(?:\s+(?:from|of|returned\s+by|given\s+by))\s+(?:the\s+)?[a-z_]+(?:\.\w+)?(?:\s+(?:tool|command|function))?\s*[:.]/i,
  /\b(?:[Rr]unning|[Ee]xecuting|[Ii]nvoking|[Cc]alling)\s+(?:the\s+)?(?:following\s+)?(?:command|tool|function|script)\s*[:.]/i,
  /\b(?:[Cc]ommand|[Ss]hell|[Tt]ool|[Ss]cript)\s+(?:output|result|response)\s*[:.]/i,
  /\bI\s+(?:ran|executed|called|used|invoked)\s+[a-z_]+(?:\.\w+)?\s+(?:and\s+)?(?:it\s+)?(?:returned|showed|produced|gave|output(?:ted)?|found)/i,
  /\b[Bb]ased\s+on\s+(?:the\s+)?(?:output|result|response|content|data|findings)\s+(?:from|of|returned\s+by|given\s+by)\s+(?:the\s+)?[a-z_]+(?:\.\w+)?/i,
  /\b[Aa]fter\s+(?:calling|running|executing|using|invoking)\s+(?:the\s+)?[a-z_]+(?:\.\w+)?/i,
  /\b[Ll]et\s+me\s+(?:use|call|run|execute|invoke|try)\s+(?:the\s+)?[a-z_]+(?:\.\w+)?\s+(?:tool|command|function)/i,
  /^(?:[Tt]ool|Command|Function)\s+[a-z_]+(?:\.\w+)?\s*[:.].*$/m,
  /\bI(?:'ll|\s+will)\s+(?:use|run|call|invoke|execute)\s+(?:[a-z_]+\s+){0,2}(?:to\s+)/i,
  /\b[Tt]he\s+(?:output|result)\s+(?:shows?|contains?|indicates?|reveals?|displays?|produced|gave|returned)\b/i,
];

export function stripToolCallArtifacts(text: string): string {
  if (!text) return '';
  let result = '';
  let remaining = text;
  while (remaining.length > 0) {
    const toolCallStart = remaining.search(/\{\s*"(?:name|function)"\s*:/);
    if (toolCallStart === -1) { result += remaining; break; }
    result += remaining.substring(0, toolCallStart);
    const braceIdx = remaining.indexOf('{', toolCallStart);
    if (braceIdx === -1) { result += remaining.substring(toolCallStart); break; }
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let endIdx = braceIdx;
    for (; endIdx < remaining.length; endIdx++) {
      const c = remaining[endIdx];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { endIdx++; break; } }
    }
    if (depth !== 0) { result += remaining.substring(braceIdx); break; }
    const jsonStr = remaining.substring(braceIdx, endIdx);
    const hasNameField = /"name"\s*:\s*"[^"]*"/.test(jsonStr);
    const hasArgsField = /\barguments\s*:/.test(jsonStr);
    if (hasNameField) {
      try {
        const parsed = JSON.parse(jsonStr);
        const name = parsed.name || parsed.function?.name;
        if (name && typeof name === 'string') {
          const after = remaining.substring(endIdx);
          const trailing = after.match(/^[\s\n]*/);
          remaining = after.substring(trailing ? trailing[0].length : 0);
          continue;
        }
      } catch {
        const after = remaining.substring(endIdx);
        const trailing = after.match(/^[\s\n]*/);
        remaining = after.substring(trailing ? trailing[0].length : 0);
        continue;
      }
    }
    if (hasArgsField && jsonStr.includes('"function"')) {
      const after = remaining.substring(endIdx);
      const trailing = after.match(/^[\s\n]*/);
      remaining = after.substring(trailing ? trailing[0].length : 0);
      continue;
    }
    result += '{';
    remaining = remaining.substring(braceIdx + 1);
  }
  text = result;
  text = text.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '');
  const unmatchedOpenIdx = text.search(/<tool_result(?:\s[^>]*)?>/);
  if (unmatchedOpenIdx !== -1) { text = text.substring(0, unmatchedOpenIdx); }
  text = text.replace(/<\/tool_result\s*>/g, '');
  text = text.replace(/<\/[\s\S]*?tool_result\s*>/g, '');
  text = text.replace(/<\/tool(?:_result)?/g, '');
  text = text.replace(/\n?<tool_result(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool_res(?:ult?)?(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool_re(?:s(?:ult?)?)?(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool_?(?:re(?:s(?:ult?)?)?)?(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<to(?:ol?)?$/g, '');
  // Only strip trailing <t or < if preceded by tool_, tool, to_, etc — never standalone
  text = text.replace(/\n?(?:<to(?:o(?:l)?)?|<\S*?t)$/g, '');
  text = text.replace(/Tool Response \([^)]+\):[^\n]*(?:\n(?!\s*(?:\n|$)|Tool Response\s*\(|{"name)[^\n]*)*/g, '');
  text = text.replace(/[a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)*"\s*,\s*"arguments"\s*:\s*\}/g, '');
  text = text.replace(/"arguments"\s*:\s*\}/g, '');
  text = text.replace(/"arguments"\s*:\s*\{\s*\}/g, '');
  text = text.replace(/,\s*"arguments"\s*:/g, '');
  text = text.replace(/"[a-z_]+(?:\.[a-z_]+)*"(?=\s*,\s*"arguments")/g, '');
  text = text.replace(/\{\s*"(?:name|function)"[^}]*\{[\s\S]*?\}\s*\}/g, '');
  text = text.replace(/\{\s*":\s*\{[\s\S]*?\}\s*\}/g, '');
  text = text.replace(
    /\{\s*"(?:filePath|content|command|pattern|oldString|newString|query|mode|action|description|email|password|url|format|limit|include|path|status|priority|name|arguments)"[\s\S]*?\}/g,
    '',
  );
  text = text.replace(/read"\s*,\s*"arguments"\s*:\s*\}/g, '');
  text = text.replace(/","arguments"\s*:\s*\}/g, '');
  text = text.replace(/"[a-z_]+",\s*"arguments"\s*:\s*\}/g, '');
  text = text.replace(/Tool Response \([a-z_]+$/gm, '');
  text = text.replace(/\}\s*,\s*"arguments"/g, '');
  text = text.replace(/^[\s]*[\]}]+[}\]}]*\s*$/gm, '');
  text = stripToolEcho(text);
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

export function stripStreamingDelta(delta: string): string {
  if (!delta) return '';
  let cleaned = delta;
  cleaned = cleaned.replace(/\[READ TOOL RESULT below[^\]]*\]\s*/g, '');
  cleaned = cleaned.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '');
  cleaned = cleaned.replace(/\n?<tool(?:_[a-z]*)?$/g, '');
  cleaned = cleaned.replace(/\n?<t(?:o(?:o(?:l)?)?)?$/g, '');
  cleaned = cleaned.replace(/(?<!:)"[a-z_]+(?:\.[a-z_]+)*"(?=\s*,\s*"arguments")/g, '');
  cleaned = cleaned.replace(/[a-z_]+"\s*,\s*"(?:arguments|parameters|argumen|argu|param)/gi, '');
  cleaned = cleaned.replace(/"arguments"\s*:\s*\}/g, '');
  cleaned = cleaned.replace(/,\s*"arguments"\s*:/g, '');
  cleaned = cleaned.replace(/(?:argumen|argument|arguments|param|parameter|parameters)":\s*/gi, '');
  cleaned = cleaned.replace(/Tool Response \([a-z_]+$/gm, '');
  cleaned = cleaned.replace(/"[a-z_]+(?:\.[a-z_]+)*"\s*,\s*"(?:arguments|parameters)"?\s*:?/gi, '');
  cleaned = cleaned.replace(/"(?:argumen|argument|arguments|param|parameter|parameters|name)"?\s*:?\s*"?$/gm, '');
  cleaned = cleaned.replace(/"?\s*:\s*"[a-z_]+(?:\.[a-z_]+)*"?\s*,?\s*"?(?:arguments|parameters)?"?\s*:?$/gm, '');
  cleaned = cleaned.replace(/^"?[a-z_]+(?:\.[a-z_]+)*"?\s*,\s*"?(?:arguments|parameters)/gm, '');
  cleaned = cleaned.replace(/\{\s*"(?:name|function)"?\s*:\s*"?$/gm, '');
  cleaned = cleaned.replace(/^"?(?:name|function)"?\s*:\s*"[a-z_]+/gm, '');
  return cleaned;
}

export function stripToolEcho(text: string): string {
  if (!text) return '';
  let result = text;
  const originalLines = text.split('\n');
  const filteredLines: string[] = [];
  for (const line of originalLines) {
    const trimmed = line.trim();
    if (!trimmed) { filteredLines.push(line); continue; }
    let isEcho = false;
    for (const pattern of TOOL_ECHO_PATTERNS) {
      if (pattern.test(trimmed)) { isEcho = true; break; }
    }
    if (!isEcho) { filteredLines.push(line); }
  }
  result = filteredLines.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

export function repairMalformedJson(malformedJson: string): string | null {
  let fixed = malformedJson.trim();
  try { JSON.parse(fixed); return null; } catch { /* continue */ }
  fixed = fixed.replace(/'/g, '"');
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
  const openBraces = (fixed.match(/{/g) || []).length;
  const closeBraces = (fixed.match(/}/g) || []).length;
  const openBrackets = (fixed.match(/\[/g) || []).length;
  const closeBrackets = (fixed.match(/\]/g) || []).length;
  if (openBraces > closeBraces) fixed += '}'.repeat(openBraces - closeBraces);
  if (openBrackets > closeBrackets) fixed += ']'.repeat(openBrackets - closeBrackets);
  try { JSON.parse(fixed); return fixed; } catch { return null; }
}
