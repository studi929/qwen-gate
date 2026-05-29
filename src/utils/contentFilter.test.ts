import test from 'node:test';
import assert from 'node:assert';
import { filterContent, stripToolCallArtifacts, stripToolEcho } from './contentFilter.ts';

test('filterContent preserves instructional "I want to" prose', () => {
  const input = 'I want to help you fix this bug.\n\nThe issue is in auth.ts line 42 where the token check uses < instead of <=.';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('fix this bug'), `cleanText should keep instructional content: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('auth.ts'), `cleanText should keep file references: "${result.cleanText}"`);
});

test('filterContent preserves "First, we need to" instructional content', () => {
  const input = 'First, we need to update the config file.\nThen, restart the server.';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('update the config'), `Should keep instructional steps: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('restart the server'), `Should keep second step: "${result.cleanText}"`);
});

test('filterContent preserves "Here is the result" with actual content', () => {
  const input = 'Here is the result of the search:\n\n\nfile1.ts\nfile2.ts\n';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('file1.ts'), `Should keep result content: "${result.cleanText}"`);
});

test('filterContent preserves "Let me show you" with code', () => {
  const input = 'Let me show you the fix:\n\ntypescript\nif (token <= now) return false;\n';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('fix'), `Should keep "show you" instructional: "${result.cleanText}"`);
});

test('filterContent strips actual thinking content', () => {
  const input = 'I am evaluating the best approach for this problem.\nLet me consider the trade-offs carefully.';
  const result = filterContent(input);
  // This IS thinking — both lines are self-referential reasoning
  assert.ok(result.thinking.length > 0, 'Should capture thinking');
});

test('filterContent strips <think> tags and captures content', () => {
  const input = '<think>This is my internal reasoning</think>\n\nHere is the answer.';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('Here is the answer'), `Should keep answer: "${result.cleanText}"`);
  assert.ok(result.thinking.includes('internal reasoning'), `Should capture thinking: "${result.thinking}"`);
  assert.ok(!result.cleanText.includes('<think>'), 'Should strip think tags from clean text');
});

test('filterContent preserves Step 1, Step 2 instructional patterns', () => {
  const input = 'Step 1: Open the terminal.\nStep 2: Run npm install.\nStep 3: Start the server.';
  const result = filterContent(input);
  assert.ok(result.cleanText.includes('Step 1'), `Should keep Step 1: "${result.cleanText}"`);
  assert.ok(result.cleanText.includes('npm install'), `Should keep commands: "${result.cleanText}"`);
});

test('stripToolCallArtifacts removes JSON tool calls', () => {
  const input = 'Some text before\n{"name":"read_file","arguments":{"path":"test.ts"}}\nSome text after';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('"name"'), `Should strip tool call JSON: "${result}"`);
  assert.ok(result.includes('Some text before'), 'Should keep text before');
  assert.ok(result.includes('Some text after'), 'Should keep text after');
});

test('stripToolCallArtifacts preserves normal JSON', () => {
  const input = 'Here is an example:\njson\n{"key": "value", "count": 42}\n';
  const result = stripToolCallArtifacts(input);
  // JSON without "name" field should be preserved
  assert.ok(result.includes('"key"'), `Should keep non-tool JSON: "${result}"`);
});

// ─── Tool Echo Guard Tests ─────────────────────────────────────────────

test('stripToolEcho: strips "I will use the X tool to..."', () => {
  const input = 'I will use the read_file tool to read the file.\nHere is what I found: the file is empty.';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('use the read_file tool'), 'Should strip tool usage narration');
  assert.ok(result.includes('Here is what I found'), 'Should keep actual content');
});

test('stripToolEcho: strips "I will run the bash tool..."', () => {
  const input = 'I will run the bash tool to execute the command.\n{"name":"bash","arguments":{"command":"ls"}}';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('I will run the bash'), 'Should strip tool usage narration');
});

test('stripToolEcho: strips "The X tool returned..."', () => {
  const input = 'The read_file tool returned the file contents.\nThe file contains 42 lines.';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('tool returned'), 'Should strip tool result echo');
  assert.ok(result.includes('42 lines'), 'Should keep actual content');
});

test('stripToolEcho: strips "Tool X result:"', () => {
  const input = 'Tool bash result: command completed successfully.\nThe output was empty.';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('Tool bash result'), 'Should strip tool result prefix');
  assert.ok(result.includes('output was empty'), 'Should keep actual content');
});

test('stripToolEcho: strips "Based on the output from X..."', () => {
  const input = 'Based on the output from grep, the pattern was found.\nThe matching line is: import fs from "fs";';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('Based on the output'), 'Should strip tool-echo reasoning');
  assert.ok(result.includes('import fs'), 'Should keep actual content');
});

test('stripToolEcho: strips "Let me use X tool..."', () => {
  const input = 'Let me use the glob tool to search for files.\nFound: src/index.ts, src/main.ts';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('Let me use the glob'), 'Should strip tool preamble');
  assert.ok(result.includes('Found:'), 'Should keep actual content');
});

test('stripToolEcho: preserves normal instructional content', () => {
  const input = 'I will help you fix this bug.\nThe issue is in auth.ts line 42.';
  const result = stripToolEcho(input);
  assert.ok(result.includes('help you fix'), 'Should keep non-tool instructional content');
  assert.ok(result.includes('auth.ts'), 'Should keep file references');
});

test('stripToolEcho: strips "Running command:"', () => {
  const input = 'Running command: ls -la\n\n{"name":"bash","arguments":{"command":"ls -la"}}';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('Running command'), 'Should strip command echo');
});

test('stripToolEcho: preserves short descriptions without tool echo', () => {
  const input = 'Found 3 files matching the pattern.\n\nsrc/index.ts\nsrc/main.ts\nsrc/utils.ts';
  const result = stripToolEcho(input);
  assert.ok(result.includes('Found 3 files'), 'Should keep short useful descriptions');
  assert.ok(result.includes('src/index.ts'), 'Should keep file listings');
});

test('stripToolEcho: strips "I will use X (without tool word)" when referencing tool-like names', () => {
  const input = 'I will execute read_file to check the file.';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('I will execute'), 'Should strip tool intent narration');
});

test('stripToolEcho: strips multi-line echo patterns', () => {
  const input = 'I will use the bash tool to run the command.\nThe bash tool returned: success.\nThe output shows the file exists.';
  const result = stripToolEcho(input);
  assert.ok(result === '', 'All lines should be stripped as echo');
});

test('stripToolEcho: strips "After running X..." preface', () => {
  const input = 'After running read_file, I can see the file contains:\n\nHello world';
  const result = stripToolEcho(input);
  assert.ok(!result.includes('After running'), 'Should strip after-running preface');
  assert.ok(result.includes('Hello world'), 'Should keep actual content');
});

test('stripToolEcho: integrated via stripToolCallArtifacts', () => {
  const input = 'I will use the read_file tool to read the file.\n{"name":"read_file","arguments":{"path":"test.ts"}}\nThe read_file tool returned: file content.\nHere is what I found:\n\nThe file is empty.';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('use the read_file tool'), 'Should strip tool usage narration');
  assert.ok(!result.includes('"name"'), 'Should strip tool call JSON');
  assert.ok(!result.includes('tool returned'), 'Should strip tool result echo');
  assert.ok(result.includes('Here is what I found'), 'Should keep actual content');
  assert.ok(result.includes('file is empty'), 'Should keep useful info');
});

test('stripToolEcho: does not strip user-facing answers that reference tools naturally', () => {
  const input = 'I used the grep command and found the pattern. Here are the matches:\n\nline1: foo\nline2: bar';
  const result = stripToolEcho(input);
  assert.ok(result.includes('line1'), 'Should keep actual results');
});

test('S3: stripToolCallArtifacts strips "arguments":} interior fragment', () => {
  const input = 'Hello\n","arguments":}\nWorld';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('"arguments"'), `Fragment not stripped: "${result}"`);
  assert.ok(result.includes('Hello'), `Content before fragment lost: "${result}"`);
  assert.ok(result.includes('World'), `Content after fragment lost: "${result}"`);
});

test('S4: stripToolCallArtifacts strips tool name + arguments fragment', () => {
  const input = 'search_web_search_exa","arguments":}';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('"arguments"'), `Arguments fragment not stripped: "${result}"`);
  assert.ok(!result.includes('search_web_search_exa'), `Tool name fragment not stripped: "${result}"`);
});

test('S4b: stripToolCallArtifacts strips concatenated fragments', () => {
  const input = '","arguments":}","arguments":}';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('"arguments"'), `Concatenated fragments not stripped: "${result}"`);
});

test('S4c: stripToolCallArtifacts strips read tool name fragment', () => {
  const input = 'read", "arguments": }';
  const result = stripToolCallArtifacts(input);
  assert.ok(!result.includes('"arguments"'), `Arguments fragment not stripped: "${result}"`);
});

test('S6: stripToolCallArtifacts preserves normal JSON in content', () => {
  const input = 'Here is an example: {"key": "value"} and more text.';
  const result = stripToolCallArtifacts(input);
  assert.ok(result.includes('"key"'), `Normal JSON was incorrectly stripped: "${result}"`);
  assert.ok(result.includes('"value"'), `Normal JSON value was incorrectly stripped: "${result}"`);
  assert.ok(result.includes('Here is an example'), `Surrounding text lost: "${result}"`);
});

test('S6b: stripToolCallArtifacts preserves code block with JSON', () => {
  const input = 'Use this config:\n\n\n{"host": "localhost", "port": 3000}\n\n\nDone.';
  const result = stripToolCallArtifacts(input);
  assert.ok(result.includes('"host"'), `Code block JSON stripped: "${result}"`);
  assert.ok(result.includes('"port"'), `Code block JSON stripped: "${result}"`);
});
