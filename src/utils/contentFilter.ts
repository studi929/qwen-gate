/*
 * File: contentFilter.ts
 * Strips Qwen's internal <think>/<thinking> tags. Preserves intentional <thought> tags.
 * Separates Qwen's thinking into reasoning_content for OpenAI API compatibility.
 */

/**
 * Result of filtering content for thinking/reasoning patterns.
 */
export interface FilterResult {
  cleanText: string;
  thinking: string;
}

const THINKING_COMBINED_PATTERN = new RegExp(
  '^(' + [
    'Thinking:',
    'I am (?:evaluating|examining|assessing|analyzing|verifying|checking|reviewing|determining|considering|processing|testing|investigating|exploring|inspecting|validating)',
    "I(?:'m| am) (?:going to|about to|trying to|planning to) ",
    '(?:The|Each|This) (?:approach|process|test|evaluation|assessment|analysis|method|strategy) ',
    '(?:Let me|I will|I\'ll) (?:think|consider|analyze|evaluate|assess|review|check|verify|examine|test|try|start|begin|proceed|continue|now) ',
    '(?:First|Next|Then|Finally),? (?:I|we|let) ',
    'OK,? (?:I|let) ',
    '(?:My|The) (?:approach|plan|strategy|goal|intention) (?:is|was) ',
    'To (?:achieve|accomplish|determine|verify|ensure|check|test|evaluate) ',
    'The (?:focus|goal|objective|purpose|aim|intent) (?:is|was) ',
    'I (?:need|want|should|must|have) to ',
    '(?:Based on|Given|According to) (?:the|my|this) (?:analysis|evaluation|assessment|findings) ',
    'After (?:analyzing|evaluating|examining|reviewing|checking|considering) ',
    '(?:It|This) (?:appears|seems|looks|sounds) (?:like|that) ',
    'From (?:the|this|my) (?:analysis|assessment|observation|perspective) ',
    '(?:In|Upon) (?:summary|conclusion|review|analysis|reflection) ',
    'The (?:file|command|output|result|tool|search) (?:contains|returned|shows|found|produced)',
    '(?:Here|Above|Below) (?:is|are) (?:the|what) (?:result|output|content|file|data)',
  ].join('|') + ')',
  'i'
);

function isThinkingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return THINKING_COMBINED_PATTERN.test(trimmed);
}

const QWEN_THINK_TAG_PATTERN = /<\/?(?:think|thinking|thought|tool_call|tool_use|function_call|tool)(?:\s[^>]{0,100})?\/?>/gi;
const QWEN_THINK_BLOCK_START = /<(?:think(?:ing)?|thought|tool_call|tool_use|function_call|tool)[\s>]/i;

export function filterContent(raw: string): FilterResult {
  if (!raw) return { cleanText: '', thinking: '' };

  let text = raw;
  const capturedThinking: string[] = [];

  while (true) {
    const startMatch = text.match(QWEN_THINK_BLOCK_START);
    if (!startMatch) break;

    const startIdx = startMatch.index!;
    const startTagEnd = text.indexOf('>', startIdx) + 1;

    const endTagName = text.substring(startIdx + 1, text.indexOf('>', startIdx));
    const endPattern = new RegExp(`</${endTagName.replace(/[\s>].*/, '')}>`, 'i');
    const endMatch = text.substring(startTagEnd).match(endPattern);

    if (endMatch) {
      const endIdx = startTagEnd + endMatch.index!;
      const thinkContent = text.substring(startTagEnd, endIdx);
      if (thinkContent.trim()) {
        capturedThinking.push(thinkContent.trim());
      }
      const before = text.substring(0, startIdx);
      const after = text.substring(endIdx + endMatch[0].length);
      const needsSpace = before.length > 0 && !/[\s\n]$/.test(before) && after.length > 0 && !/^[\s\n]/.test(after);
      text = before + (needsSpace ? ' ' : '') + after;
    } else {
      capturedThinking.push(text.substring(startTagEnd).trim());
      const before = text.substring(0, startIdx);
      text = before + (before.length > 0 && !/[\s\n]$/.test(before) ? ' ' : '');
      break;
    }
  }

  text = text.replace(QWEN_THINK_TAG_PATTERN, ' ');

  const paragraphs = text.split(/\n\s*\n/);
  const cleanParagraphs: string[] = [];

  for (const para of paragraphs) {
    const paraLines = para.split('\n').filter(l => l.trim().length > 0);
    if (paraLines.length === 0) {
      cleanParagraphs.push('');
      continue;
    }

    const thinkingCount = paraLines.filter(l => isThinkingLine(l)).length;
    const startsWithThinking = isThinkingLine(paraLines[0]);
    const isStrongThinkingStart = /^Thinking:/i.test(paraLines[0]) || /^I am (evaluating|examining|assessing|analyzing)/i.test(paraLines[0]);

    // Clear content markers — lines that indicate actual answer content
    const hasContentMarker = paraLines.some(l =>
      /^[#]{1,4}\s/.test(l) ||      // Markdown headings
      /^\$\s/.test(l) ||            // Shell commands
      /^[|+-]{2,}/.test(l) ||       // Table borders
      /^\|.*\|/.test(l) ||          // Table rows
      /^[[{"]/.test(l) ||          // JSON/array start
      /^[✓✗✔✘✅❌]/.test(l) ||      // Checkboxes
      /^[A-Z][a-z]+ [a-z]+:/.test(l) // "Tool Status:" etc
    );

    if (isStrongThinkingStart && !hasContentMarker) {
      // Paragraph starts with strong thinking → whole paragraph is thinking
      capturedThinking.push(paraLines.join('\n'));
    } else if (thinkingCount >= 2 && !hasContentMarker) {
      // Multiple thinking lines → whole paragraph is thinking
      capturedThinking.push(paraLines.join('\n'));
    } else if (startsWithThinking && thinkingCount === 1 && paraLines.length === 1) {
      // Single thinking line as its own paragraph — could be a heading, keep as content
      cleanParagraphs.push(para);
    } else {
      cleanParagraphs.push(para);
    }
  }

  text = cleanParagraphs.join('\n\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // ── Pass 3: Strip any remaining tool call JSON and Tool Response echoes ──
  text = stripToolCallArtifacts(text);

  return {
    cleanText: text,
    thinking: capturedThinking.filter(t => t.length > 0).join('\n'),
  };
}

/**
 * Strips raw JSON tool call artifacts from text — catches any tool call JSON that
 * the StreamingToolParser missed or that leaked through in the non-streaming path.
 * Also removes "Tool Response (name): ..." echoes that the model may reproduce
 * from the message history, preventing context window bloat on the client side.
 */
export function stripToolCallArtifacts(text: string): string {
  if (!text) return '';

  // ── Pass 1: Strip raw JSON tool calls: {"name":"...","arguments":{...}} ─
  let result = '';
  let remaining = text;

  while (remaining.length > 0) {
    // Find potential tool call start: {"name" or {"function"
    const toolCallStart = remaining.search(/\{\s*"(?:name|function)"\s*:/);
    if (toolCallStart === -1) {
      result += remaining;
      break;
    }

    result += remaining.substring(0, toolCallStart);

    // Find the opening brace for scanning
    const braceIdx = remaining.indexOf('{', toolCallStart);
    if (braceIdx === -1) {
      result += remaining.substring(toolCallStart);
      break;
    }

    // Scan for balanced closing brace
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
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          endIdx++; // include the closing brace
          break;
        }
      }
    }

    if (depth !== 0) {
      // Unbalanced — emit everything and stop
      result += remaining.substring(braceIdx);
      break;
    }

    const jsonStr = remaining.substring(braceIdx, endIdx);

    // Quick check: does it look like a tool call?
    // Strip any JSON with a "name" field — even partial/malformed ones without "arguments".
    // This prevents tool-call JSON fragments from echoing back into the context window.
    const hasNameField = /"name"\s*:\s*"[^"]*"/.test(jsonStr);
    const hasArgsField = /\barguments\s*:/.test(jsonStr);
    if (hasNameField) {
      try {
        const parsed = JSON.parse(jsonStr);
        const name = parsed.name || parsed.function?.name;
        if (name && typeof name === 'string') {
          // Skip tool call + trailing whitespace/newline
          const after = remaining.substring(endIdx);
          const trailing = after.match(/^[\s\n]*/);
          const skipLen = trailing ? trailing[0].length : 0;
          remaining = after.substring(skipLen);
          continue;
        }
      } catch {
        // Malformed JSON but it LOOKS like a tool call (has "name":"...")
        // Strip it anyway to prevent context bloat from garbled tool call output.
        const after = remaining.substring(endIdx);
        const trailing = after.match(/^[\s\n]*/);
        const skipLen = trailing ? trailing[0].length : 0;
        remaining = after.substring(skipLen);
        continue;
      }
    }
    // Also strip JSON with arguments field even without name (incomplete tool calls)
    if (hasArgsField && jsonStr.includes('"function"')) {
      const after = remaining.substring(endIdx);
      const trailing = after.match(/^[\s\n]*/);
      const skipLen = trailing ? trailing[0].length : 0;
      remaining = after.substring(skipLen);
      continue;
    }

    // Not a tool call after all — emit the opening brace and continue
    result += '{';
    remaining = remaining.substring(braceIdx + 1);
  }

  text = result;

  text = text.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '');

  const unmatchedOpenIdx = text.search(/<tool_result(?:\s[^>]*)?>/);
  if (unmatchedOpenIdx !== -1) {
    text = text.substring(0, unmatchedOpenIdx);
  }

  // ── Pass 2b: Strip orphaned closing </tool_result> tags ────────────
  text = text.replace(/<\/tool_result\s*>/g, '');

  // ── Pass 2c: Strip partial/incomplete opening <tool_result tag at EOL ─
  // Catches streaming fragments like "<tool_resul", "<tool_result", "<tool_result name="bash"
  text = text.replace(/\n?<tool_result(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool_res(?:ult?)?(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool_re(?:s(?:ult?)?)?(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool_?(?:re(?:s(?:ult?)?)?)?(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<tool(?:\s[^>]*)?$/g, '');
  text = text.replace(/\n?<to(?:ol?)?$/g, '');
  text = text.replace(/\n?<t?$/g, '');

  // ── Pass 2d: Strip legacy "Tool Response (name): ..." echoes ───────
  // Backwards compatibility: if old-format tool responses leak through,
  // strip them too. Same regex as before.
  text = text.replace(/Tool Response \([^)]+\):[^\n]*(?:\n(?!\s*(?:\n|$)|Tool Response\s*\(|{"name)[^\n]*)*/g, '');

  // ── Pass 2.5: Strip tool call interior fragments ──
  // These appear when JSON splits across chunk boundaries during streaming
  text = text.replace(/[a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)*"\s*,\s*"arguments"\s*:\s*\}/g, '');
  text = text.replace(/"arguments"\s*:\s*\}/g, '');
  text = text.replace(/"arguments"\s*:\s*\{\s*\}/g, '');
  text = text.replace(/,\s*"arguments"\s*:/g, '');
  text = text.replace(/"[a-z_]+(?:\.[a-z_]+)*"(?=\s*,\s*"arguments")/g, '');
  text = text.replace(/read"\s*,\s*"arguments"\s*:\s*\}/g, '');
  text = text.replace(/","arguments"\s*:\s*\}/g, '');
  text = text.replace(/"[a-z_]+",\s*"arguments"\s*:\s*\}/g, '');
  text = text.replace(/Tool Response \([a-z_]+$/gm, '');
  text = text.replace(/\}\s*,\s*"arguments"/g, '');

  // ── Pass 3: Strip trailing dangling tool call tails like `}]}}}` ──
  // These can appear when a tool call array gets partially rendered.
  text = text.replace(/^[\s]*[\]}]+[}\]}]*\s*$/gm, '');

  // ── Pass 4: Strip tool-usage echo from output ───────────────────────
  // When the model describes what tool it's calling or what a tool returned,
  // that text is redundant — the tool_calls are already structured data and
  // the client already has the tool results. This echo blasts the context
  // window with information nobody needs to see twice.
  text = stripToolEcho(text);

  text = text.replace(/\n{3,}/g, '\n\n');

  return text;
}

export function stripStreamingDelta(delta: string): string {
  if (!delta) return '';
  let cleaned = delta;

  cleaned = cleaned.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g, '');
  cleaned = cleaned.replace(/<\/tool_result>/g, '');
  cleaned = cleaned.replace(/\n?<tool(?:_[a-z]*)?$/g, '');
  cleaned = cleaned.replace(/\n?<t(?:o(?:o(?:l)?)?)?$/g, '');

  // Original patterns
  cleaned = cleaned.replace(/"arguments"\s*:\s*\}/g, '');
  cleaned = cleaned.replace(/,\s*"arguments"\s*:/g, '');
  cleaned = cleaned.replace(/"[a-z_]+(?:\.[a-z_]+)*"(?=\s*,\s*"arguments")/g, '');
  cleaned = cleaned.replace(/Tool Response \([a-z_]+$/gm, '');
  
  // Enhanced patterns for 02.md fragments: catch partial JSON from split tool calls
  // Tool name fragments: bash", "arguments or read", "arguments
  cleaned = cleaned.replace(/"[a-z_]+(?:\.[a-z_]+)*"\s*,\s*"(?:arguments|parameters)"?\s*:?/gi, '');
  
  // Partial field names: "argumen or "arguments": or "name":
  cleaned = cleaned.replace(/"(?:argumen|argument|arguments|param|parameter|parameters|name)"?\s*:?\s*"?$/gm, '');
  
  // Orphaned JSON fragments: ": "bash", or name": "read"
  cleaned = cleaned.replace(/"?\s*:\s*"[a-z_]+(?:\.[a-z_]+)*"?\s*,?\s*"?(?:arguments|parameters)?"?\s*:?$/gm, '');
  cleaned = cleaned.replace(/^"?[a-z_]+(?:\.[a-z_]+)*"?\s*,\s*"?(?:arguments|parameters)/gm, '');
  
  // Stray quotes and braces that indicate partial JSON
  cleaned = cleaned.replace(/\{\s*"(?:name|function)"?\s*:\s*"?$/gm, '');
  cleaned = cleaned.replace(/^"?(?:name|function)"?\s*:\s*"[a-z_]+/gm, '');
  
  return cleaned;
}

/**
 * Tool echo patterns — the model describing its own tool usage in natural language.
 * When the model calls tools, it sometimes also writes sentences like:
 *   "I'll use the read_file tool to read the file..."
 *   "The bash command returned: ..."
 *   "Based on the output of grep..."
 * This text is redundant because tool_calls and tool results are already structured
 * data. Stripping it prevents context window bloat.
 *
 * Each pattern targets a specific "echo" structure. Patterns are ordered by
 * specificity (most specific first) to minimize false positives.
 */
const TOOL_ECHO_PATTERNS: RegExp[] = [
  // "I'll use/call/run the X tool/command to..."
  /\bI(?:'ll|\s+will|\s+shall|\s+can|\s+need\s+to)\s+(?:use|run|call|invoke|execute|try)\s+(?:the\s+)?[a-z_]+(?:\.\w+)?\s+(?:tool|command|function|utility)/gi,

  // "Using the X tool to/for..."
  /\bUsing\s+(?:the\s+)?[a-z_]+(?:\.\w+)?\s+(?:tool|command|function|utility)\s+(?:to|for|I)/gi,

  // "The X tool/command returned/shows/produced/found..."
  /\b[Tt]he\s+[a-z_]+(?:\.\w+)?\s+(?:tool|command|function|utility)\s+(?:returned|shows?|produced|found|gave|output(?:ted)?|contained|has|displays?)/gi,

  // "Tool X result/output/response:" or "Tool X returned/showed:"
  /\b[Tt]ool\s+[a-z_]+(?:\.\w+)?\s+(?:result|output|response|returned|shows?|found|gave|produced)\s*[:.]/gi,

  // "Result from/returned by X:" or "Output from X:" or "Response from tool X:"
  /\b(?:result|output|response)(?:\s+(?:from|of|returned\s+by|given\s+by))\s+(?:the\s+)?[a-z_]+(?:\.\w+)?(?:\s+(?:tool|command|function))?\s*[:.]/gi,

  // "Running/Executing command/tool X..."
  /\b(?:[Rr]unning|[Ee]xecuting|[Ii]nvoking|[Cc]alling)\s+(?:the\s+)?(?:following\s+)?(?:command|tool|function|script)\s*[:.]/gi,

  // "Command output:" or "Shell output:" or "Tool output:"
  /\b(?:[Cc]ommand|[Ss]hell|[Tt]ool|[Ss]cript)\s+(?:output|result|response)\s*[:.]/gi,

  // "I ran/executed/called X and it returned/showed..."
  /\bI\s+(?:ran|executed|called|used|invoked)\s+[a-z_]+(?:\.\w+)?\s+(?:and\s+)?(?:it\s+)?(?:returned|showed|produced|gave|output(?:ted)?|found)/gi,

  /\b[Bb]ased\s+on\s+(?:the\s+)?(?:output|result|response|content|data|findings)\s+(?:from|of|returned\s+by|given\s+by)\s+(?:the\s+)?[a-z_]+(?:\.\w+)?/gi,

  // "After calling/running/executing X..."
  /\b[Aa]fter\s+(?:calling|running|executing|using|invoking)\s+(?:the\s+)?[a-z_]+(?:\.\w+)?/gi,

  // "Let me use/call/run X tool..."
  /\b[Ll]et\s+me\s+(?:use|call|run|execute|invoke|try)\s+(?:the\s+)?[a-z_]+(?:\.\w+)?\s+(?:tool|command|function)/gi,

  // Single-line "Tool X:" at start of line (describing a tool call in text)
  /^(?:[Tt]ool|Command|Function)\s+[a-z_]+(?:\.\w+)?\s*[:.].*$/gm,

  // "I'll use/run X" (without "tool" word but referencing a tool-like name)
  /\bI(?:'ll|\s+will)\s+(?:use|run|call|invoke|execute)\s+(?:[a-z_]+\s+){0,2}(?:to\s+)/gi,

  // "The output/result shows/contains/indicates... (tool result echo)"
  /\b[Tt]he\s+(?:output|result)\s+(?:shows?|contains?|indicates?|reveals?|displays?|produced|gave|returned)\b/gi,
];

/**
 * Strip tool-usage echo from model output.
 * The model sometimes injects natural-language descriptions of its own tool
 * usage (e.g., "I'll use the read_file tool to read the file"). These are
 * redundant because tool_calls are already structured data. This function
 * removes those echo lines from the text output.
 */
export function stripToolEcho(text: string): string {
  if (!text) return '';

  let result = text;
  const originalLines = text.split('\n');
  const filteredLines: string[] = [];

  for (const line of originalLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      filteredLines.push(line);
      continue;
    }

    // Check if this line matches any echo pattern
    let isEcho = false;
    for (const pattern of TOOL_ECHO_PATTERNS) {
      if (pattern.test(trimmed)) {
        isEcho = true;
        break;
      }
    }

    if (!isEcho) {
      filteredLines.push(line);
    }
  }

  result = filteredLines.join('\n');

  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

/**
 * Attempts to repair common JSON syntax errors in tool call strings.
 * Inspired by LangServe's auto-repair pattern for graceful recovery.
 * 
 * @param malformedJson - The potentially malformed JSON string
 * @returns Repaired JSON string, or null if repair is not possible
 */
export function repairMalformedJson(malformedJson: string): string | null {
  let fixed = malformedJson.trim();
  
  // Skip if already valid
  try {
    JSON.parse(fixed);
    return null; // Already valid, no repair needed
  } catch {
    // Continue with repair attempts
  }
  
  // Fix 1: Replace single quotes with double quotes (common AI output error)
  fixed = fixed.replace(/'/g, '"');
  
  // Fix 2: Remove trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  
  // Fix 3: Ensure keys are double-quoted (handle unquoted keys)
  // Match: {key: or ,key: and replace with {"key": or ,"key":
  fixed = fixed.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
  
  // Fix 4: Handle missing closing braces/brackets (simple heuristic)
  const openBraces = (fixed.match(/{/g) || []).length;
  const closeBraces = (fixed.match(/}/g) || []).length;
  const openBrackets = (fixed.match(/\[/g) || []).length;
  const closeBrackets = (fixed.match(/\]/g) || []).length;
  
  if (openBraces > closeBraces) {
    fixed += '}'.repeat(openBraces - closeBraces);
  }
  if (openBrackets > closeBrackets) {
    fixed += ']'.repeat(openBrackets - closeBrackets);
  }
  
  // Final validation: only return if now valid JSON
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    return null; // Repair failed
  }
}
