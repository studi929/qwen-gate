import test from 'node:test';
import assert from 'node:assert';
import { filterContent, stripToolCallArtifacts, stripToolEcho, stripStreamingDelta } from './contentFilter.ts';

// ── Streaming chunk simulation ──────────────────────────────────────────
// Simulates how text arrives in real SSE streaming: variable-sized word
// groups, stripStreamingDelta applied per-chunk, then accumulated.

const TRC = '<' + '/tool_result>';

function toolBlock(name: string, callId: string, content: string): string {
  return '<tool_result name="' + name + '" call_id="' + callId + '">\n' + content + '\n' + TRC;
}

/**
 * Split text into variable-length word groups to simulate SSE chunk boundaries.
 * Each token includes trailing whitespace so chunks reassemble with correct spacing.
 */
function streamChunks(text: string): string[] {
  const tokens = text.match(/\S+\s*/g) || [];
  const chunks: string[] = [];
  const pattern = [2, 4, 3, 5, 2];
  let i = 0, pi = 0;
  while (i < tokens.length) {
    const size = Math.min(pattern[pi % pattern.length], tokens.length - i);
    chunks.push(tokens.slice(i, i + size).join(''));
    i += size;
    pi++;
  }
  return chunks;
}

/**
 * Simulate real streaming pipeline:
 * 1. Split text into streaming chunks
 * 2. Apply stripStreamingDelta per chunk (as done in the SSE loop)
 * 3. Accumulate deltas
 * 4. Apply the target function on accumulated text
 */
function streamThenApply(text: string, fn: (s: string) => string): string {
  const chunks = streamChunks(text);
  const deltas = chunks.map(c => stripStreamingDelta(c));
  return fn(deltas.join(''));
}

/** Simulate streaming + filterContent (returns cleanText + thinking). */
function streamThenFilter(text: string): { cleanText: string; thinking: string } {
  const chunks = streamChunks(text);
  const deltas = chunks.map(c => stripStreamingDelta(c));
  return filterContent(deltas.join(''));
}

// ── filterContent tests ─────────────────────────────────────────────────

test('filterContent preserves instructional "I want to" prose', () => {
  const input = 'I want to help you fix this bug.\n\nThe issue is in auth.ts line 42 where the token check uses < instead of <=.';
  const result = streamThenFilter(input);
  assert.ok(result.cleanText.includes('fix this bug'), `cleanText should keep instructional content: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('auth.ts'), `cleanText should keep file references: "${result.cleanText}"`);
});

test('filterContent preserves "First, we need to" instructional content', () => {
  const input = 'First, we need to update the config file.\nThen, restart the server.';
  const result = streamThenFilter(input);
  assert.ok(result.cleanText.includes('update the config'), `Should keep instructional steps: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('restart the server'), `Should keep second step: "${result.cleanText}"`);
});

test('filterContent preserves "Here is the result" with actual content', () => {
  const input = 'Here is the result of the search:\n\n\nfile1.ts\nfile2.ts\n';
  const result = streamThenFilter(input);
  assert.ok(result.cleanText.includes('file1.ts'), `Should keep result content: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('file2.ts'), `Should keep result content: "${result.cleanText}"`);
});

test('filterContent preserves "Let me show you" with code', () => {
  const input = 'Let me show you the fix:\n\ntypescript\nif (token <= now) return false;\n';
  const result = streamThenFilter(input);
  assert.ok(result.cleanText.includes('fix'), `Should keep "show you" instructional: "${result.cleanText}"`);
});

test('filterContent strips actual thinking content', () => {
  const input = 'I am evaluating the best approach for this problem.\nLet me consider the trade-offs carefully.';
  const result = streamThenFilter(input);
  // This IS thinking — both lines are self-referential reasoning
  assert.ok(result.thinking.length > 0, 'Should capture thinking');
});

test('filterContent strips <think> tags and captures content', () => {
  const input = '<think>This is my internal reasoning</think>\n\nHere is the answer.';
  const result = streamThenFilter(input);
  assert.ok(result.cleanText.includes('Here is the answer'), `Should keep answer: "${result.cleanText}"`);
  assert.ok(result.thinking.includes('internal reasoning'), `Should capture thinking: "${result.thinking}"`);
  assert.ok(!result.cleanText.includes('<think>'), 'Should strip think tags from clean text');
});

test('filterContent preserves Step 1, Step 2 instructional patterns', () => {
  const input = 'Step 1: Open the terminal.\nStep 2: Run npm install.\nStep 3: Start the server.';
  const result = streamThenFilter(input);
  assert.ok(result.cleanText.includes('Step 1'), `Should keep Step 1: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('npm install'), `Should keep commands: "${result.cleanText}"`);
});

// ── stripToolCallArtifacts tests ────────────────────────────────────────

test('stripToolCallArtifacts removes JSON tool calls', () => {
  const input = 'Some text before\n{"name":"read_file","arguments":{"path":"test.ts"}}\nSome text after';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('"name"'), `Should strip tool call JSON: "${result}"`);
  assert.ok(result.includes('Some text before'), 'Should keep text before');
  assert.ok(result.includes('Some text after'), 'Should keep text after');
});

test('stripToolCallArtifacts preserves normal JSON', () => {
  const input = 'Here is some JSON: {"key": "value"}';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.strictEqual(result, input);
});

// ─── Tool Echo Guard Tests ─────────────────────────────────────────────

test('stripToolEcho: strips "I will use the X tool to..."', () => {
  const input = 'I will use the read_file tool to read the file.\nHere is what I found: the file is empty.';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('use the read_file tool'), 'Should strip tool usage narration');
  assert.ok(result.includes('Here is what I found'), 'Should keep actual content');
});

test('stripToolEcho: strips "I will run the bash tool..."', () => {
  const input = 'I will run the bash tool to execute the command.\n{"name":"bash","arguments":{"command":"ls"}}';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('I will run the bash'), 'Should strip tool usage narration');
});

test('stripToolEcho: strips "The X tool returned..."', () => {
  const input = 'The read_file tool returned the file contents.\nThe file contains 42 lines.';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('tool returned'), 'Should strip tool result echo');
  assert.ok(result.includes('42 lines'), 'Should keep actual content');
});

test('stripToolEcho: strips "Tool X result:"', () => {
  const input = 'Tool bash result: command completed successfully.\nThe output was empty.';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('Tool bash result'), 'Should strip tool result prefix');
  assert.ok(result.includes('output was empty'), 'Should keep actual content');
});

test('stripToolEcho: strips "Based on the output from X..."', () => {
  const input = 'Based on the output from grep, the pattern was found.\nThe matching line is: import fs from "fs";';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('Based on the output'), 'Should strip tool-echo reasoning');
  assert.ok(result.includes('import fs'), 'Should keep actual content');
});

test('stripToolEcho: strips "Let me use X tool..."', () => {
  const input = 'Let me use the glob tool to search for files.\nFound: src/index.ts, src/main.ts';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('Let me use the glob'), 'Should strip tool preamble');
  assert.ok(result.includes('Found:'), 'Should keep actual content');
});

test('stripToolEcho: preserves normal instructional content', () => {
  const input = 'I will help you fix this bug.\nThe issue is in auth.ts line 42.';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(result.includes('help you fix'), 'Should keep non-tool instructional content');
  assert.ok(result.includes('auth.ts'), 'Should keep file references');
});

test('stripToolEcho: strips "Running command:"', () => {
  const input = 'Running command: ls -la\n\n{"name":"bash","arguments":{"command":"ls -la"}}';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('Running command'), 'Should strip command echo');
});

test('stripToolEcho: preserves short descriptions without tool echo', () => {
  const input = 'Found 3 files matching the pattern.\n\nsrc/index.ts\nsrc/main.ts\nsrc/utils.ts';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(result.includes('Found 3 files'), 'Should keep short useful descriptions');
  assert.ok(result.includes('src/index.ts'), 'Should keep file listings');
});

test('stripToolEcho: strips "I will use X (without tool word)" when referencing tool-like names', () => {
  const input = 'I will execute read_file to check the file.';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('I will execute'), 'Should strip tool intent narration');
});

test('stripToolEcho: strips "After running X..." preface', () => {
  const input = 'After running read_file, I can see the file contains:\n\nHello world';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(!result.includes('After running'), 'Should strip after-running preface');
  assert.ok(result.includes('Hello world'), 'Should keep actual content');
});

// Multi-line echo: stripToolEcho should strip all echo lines from accumulated stream
test('stripToolEcho: strips multi-line echo patterns', () => {
  const input = 'I will use the bash tool to run the command.\nThe bash tool returned: success.\nThe output shows the file exists.';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(result.length === 0 || !/[a-z]{3,}/i.test(result),
    'All substantial lines should be stripped as echo');
});

test('stripToolEcho: integrated via stripToolCallArtifacts', () => {
  const input = 'I will use the read_file tool to read the file.\n{"name":"read_file","arguments":{"path":"test.ts"}}\nThe read_file tool returned: file content.\nHere is what I found:\n\nThe file is empty.';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('use the read_file tool'), 'Should strip tool usage narration');
  assert.ok(!result.includes('"name"'), 'Should strip tool call JSON');
  assert.ok(!result.includes('tool returned'), 'Should strip tool result echo');
  assert.ok(result.includes('Here is what I found'), 'Should keep actual content');
  assert.ok(result.includes('file is empty'), 'Should keep useful info');
});

test('stripToolEcho: does not strip user-facing answers that reference tools naturally', () => {
  const input = 'I used the grep command and found the pattern. Here are the matches:\n\nline1: foo\nline2: bar';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(result.includes('line1'), 'Should keep actual results');
  assert.ok(result.includes('line2'), 'Should keep actual results');
});

test('stripToolEcho preserves "Based on the results" reasoning', () => {
  const input = 'Based on the results, the fix is in auth.ts.';
  const result = streamThenApply(input, stripToolEcho);
  assert.ok(result.includes('Based on the results'), 'Legitimate reasoning stripped: ' + JSON.stringify(result));
});

// ── Fragment cleanup tests (S3–S6) ──────────────────────────────────────
// These test that stripToolCallArtifacts on accumulated streaming output
// handles partial JSON fragments that survived stripStreamingDelta.

test('S3: stream + stripToolCallArtifacts strips "arguments":} interior fragment', () => {
  const input = 'Hello\n","arguments":}\nWorld';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('"arguments"'), `Fragment not stripped: "${result}"`);
  assert.ok(result.includes('Hello'), `Content before fragment lost: "${result}"`);
  assert.ok(result.includes('World'), `Content after fragment lost: "${result}"`);
});

test('S4: stream + stripToolCallArtifacts strips tool name + arguments fragment', () => {
  const input = 'search_web_search_exa","arguments":}';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('"arguments"'), `Arguments fragment not stripped: "${result}"`);
  assert.ok(!result.includes('search_web_search_exa'), `Tool name fragment not stripped: "${result}"`);
});

test('S4b: stream + stripToolCallArtifacts strips concatenated fragments', () => {
  const input = '","arguments":}","arguments":}';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('"arguments"'), `Concatenated fragments not stripped: "${result}"`);
});

test('S4c: stream + stripToolCallArtifacts strips read tool name fragment', () => {
  const input = 'read", "arguments": }';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('"arguments"'), `Arguments fragment not stripped: "${result}"`);
});

test('S6: stream + stripToolCallArtifacts preserves normal JSON in content', () => {
  const input = 'Here is an example: {"key": "value"} and more text.';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(result.includes('"key"'), `Normal JSON was incorrectly stripped: "${result}"`);
  assert.ok(result.includes('"value"'), `Normal JSON value was incorrectly stripped: "${result}"`);
  assert.ok(result.includes('Here is an example'), `Surrounding text lost: "${result}"`);
});

test('S6b: stream + stripToolCallArtifacts preserves code block with JSON', () => {
  const input = 'Use this config:\n\n\n{"host": "localhost", "port": 3000}\n\n\nDone.';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(result.includes('"host"'), `Code block JSON stripped: "${result}"`);
  assert.ok(result.includes('"port"'), `Code block JSON stripped: "${result}"`);
});

// ── XML leak tests ──────────────────────────────────────────────────────

test('XML-1: stream + stripToolCallArtifacts strips complete tool_result blocks', () => {
  const input = 'Here is my analysis.\n\n' + toolBlock('bash', 'tc_123', 'file1.ts\nfile2.ts\nline 42: error') + '\n\nBased on the results, the fix is in auth.ts.';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('<tool_result'), 'tool_result tag leaked: ' + JSON.stringify(result));
  assert.ok(!result.includes('file1.ts'), 'tool content leaked: ' + JSON.stringify(result));
  assert.ok(!result.includes('line 42: error'), 'tool content leaked: ' + JSON.stringify(result));
  assert.ok(result.includes('Here is my analysis'), 'Pre-text lost: ' + JSON.stringify(result));
  assert.ok(result.includes('Based on the results'), 'Post-text lost: ' + JSON.stringify(result));
});

test('XML-2: stream + stripToolCallArtifacts strips multiple tool_result blocks', () => {
  const input = 'Starting work.\n\n' + toolBlock('bash', 'tc_1', 'output1') + '\n\nNow checking files.\n\n' + toolBlock('read', 'tc_2', 'file content here') + '\n\nAll done.';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('output1'), 'First tool content leaked: ' + JSON.stringify(result));
  assert.ok(!result.includes('file content here'), 'Second tool content leaked: ' + JSON.stringify(result));
  assert.ok(result.includes('Starting work'), 'Pre-text lost: ' + JSON.stringify(result));
  assert.ok(result.includes('Now checking files'), 'Mid-text lost: ' + JSON.stringify(result));
  assert.ok(result.includes('All done'), 'Post-text lost: ' + JSON.stringify(result));
});

test('XML-3: stream + stripToolCallArtifacts strips orphaned closing tags', () => {
  const input = 'Some text with orphaned closing\n' + TRC + '\nMore text.';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('tool_result>'), 'Orphaned close tag leaked: ' + JSON.stringify(result));
  assert.ok(result.includes('Some text'), 'Pre-text lost: ' + JSON.stringify(result));
  assert.ok(result.includes('More text'), 'Post-text lost: ' + JSON.stringify(result));
});

test('XML-4: stream + stripToolCallArtifacts strips partial opening tag at end of text', () => {
  const input = 'Analysis complete.\n<tool_result name="bash"';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('<tool_result'), 'Partial open tag leaked: ' + JSON.stringify(result));
  assert.ok(result.includes('Analysis complete'), 'Pre-text lost: ' + JSON.stringify(result));
});

// XML-5 tests stripStreamingDelta directly (it is a per-chunk function)
test('XML-5: stripStreamingDelta strips partial tool_result tag fragments', () => {
  const input1 = 'Some text\n<tool_resul';
  const result1 = stripStreamingDelta(input1);
  assert.ok(!result1.includes('<tool_resul'), 'Partial tag fragment leaked: ' + JSON.stringify(result1));

  const input2 = 'text\n<tool_result';
  const result2 = stripStreamingDelta(input2);
  assert.ok(!result2.includes('<tool_result'), 'Opening tag leaked: ' + JSON.stringify(result2));

  // Complete </tool_result> is NOT stripped by stripStreamingDelta — stripToolCallArtifacts
  // handles closing tags on accumulated text where it can match opening+close pairs.
  const input3 = 'content\n' + TRC;
  const result3 = stripStreamingDelta(input3);
  // Only partial tag fragments (<tool, <tool_, <tool_resul) are stripped per-chunk.
  assert.ok(result3.includes('</tool_result>'), 'Complete closing tag should survive stripStreamingDelta: ' + JSON.stringify(result3));
});

test('XML-7: stream + stripToolCallArtifacts strips unmatched opening tag with trailing content (mid-stream leak)', () => {
  const input = 'Here is the answer.\n<tool_result name="read" call_id="123">\nfile content here\nmore leaked content';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('<tool_result'), 'Opening tag leaked: ' + JSON.stringify(result));
  assert.ok(!result.includes('file content'), 'Tool result content leaked: ' + JSON.stringify(result));
  assert.ok(result.includes('Here is the answer'), 'Pre-text lost: ' + JSON.stringify(result));
});

test('XML-8: stream + stripToolCallArtifacts strips unmatched opening tag after complete block removed', () => {
  const input = '<tool_result name="bash" call_id="1">\noutput\n</tool_result>\n\nMiddle.\n<tool_result name="read" call_id="2">\nleaked';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(!result.includes('<tool_result'), 'Second opening tag leaked: ' + JSON.stringify(result));
  assert.ok(!result.includes('leaked'), 'Second block content leaked: ' + JSON.stringify(result));
  assert.ok(result.includes('Middle'), 'Pre-second-block text lost: ' + JSON.stringify(result));
});

test('XML-6: stream + stripToolCallArtifacts preserves non-tool XML in content', () => {
  const input = 'Here is an HTML example:\n\n<div class="container">\n  <p>Hello</p>\n</div>\n\nAnd some JSX:\n\n<Component prop="value" />';
  const result = streamThenApply(input, stripToolCallArtifacts);
  assert.ok(result.includes('<div'), 'HTML div stripped: ' + JSON.stringify(result));
  assert.ok(result.includes('<p>Hello</p>'), 'HTML p stripped: ' + JSON.stringify(result));
  assert.ok(result.includes('<Component'), 'JSX stripped: ' + JSON.stringify(result));
});

// ── System marker tests ─────────────────────────────────────────────────

test('SYS-1: stream + filterContent strips leaked [READ TOOL RESULT] markers', () => {
  const input = 'Here is my answer.\n[READ TOOL RESULT below, then decide: call another tool or respond to the user]\nMore text here.';
  const result = streamThenFilter(input);
  assert.ok(!result.cleanText.includes('[READ TOOL RESULT'), 'Marker leaked: ' + JSON.stringify(result.cleanText));
  assert.ok(result.cleanText.includes('Here is my answer.'), 'Normal content stripped');
  assert.ok(result.cleanText.includes('More text here.'), 'Normal content stripped');
});

test('SYS-2: stripStreamingDelta strips leaked [READ TOOL RESULT] markers', () => {
  const input = 'Answer text\n[READ TOOL RESULT below, then decide: call another tool or respond to the user]\n';
  const result = stripStreamingDelta(input);
  assert.ok(!result.includes('[READ TOOL RESULT'), 'Marker leaked: ' + JSON.stringify(result));
});
