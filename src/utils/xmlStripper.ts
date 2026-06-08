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
  // Strip XML tool_result blocks
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
  // Only strip trailing tool-related partial tags — never standalone <t
  text = text.replace(/\n?(?:<\/?(?:tool|tc|function|parameter)[^>]*)$/gi, '');
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
