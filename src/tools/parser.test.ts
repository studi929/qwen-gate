import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { StreamingToolParser } from './parser.ts';

describe('StreamingToolParser flush leak vector', () => {
  it('S1: flush drops non-tool-call JSON instead of emitting as text', () => {
    const parser = new StreamingToolParser();
    // Feed text containing a JSON object that is NOT a tool call
    // (no "name" + "arguments"/"function"/"parameters" pattern)
    const feedResult = parser.feed('Some text {"random": "json"} more text');
    const flushResult = parser.flush();
    
    // Accumulate text from both feed() and flush() since text is emitted incrementally
    const allText = feedResult.text + flushResult.text;
    
    // The JSON should be DROPPED, not emitted as text
    // Text should contain only the parts before/after the JSON
    assert.ok(!allText.includes('"random"'), 
      `Non-tool-call JSON leaked as text: "${allText}"`);
    assert.ok(!allText.includes('"json"'), 
      `Non-tool-call JSON value leaked as text: "${allText}"`);
    // Text before/after JSON should be preserved
    assert.ok(allText.includes('Some text'), 
      `Text before JSON lost: "${allText}"`);
    assert.ok(allText.includes('more text'), 
      `Text after JSON lost: "${allText}"`);
    assert.strictEqual(feedResult.toolCalls.length + flushResult.toolCalls.length, 0);
  });

  it('S2: flush drops JSON with name but no arguments as non-tool-call', () => {
    const parser = new StreamingToolParser();
    const feedResult = parser.feed('prefix {"not_a_tool":true,"random_field":42} suffix');
    const flushResult = parser.flush();
    
    const allText = feedResult.text + flushResult.text;
    
    assert.ok(!allText.includes('"not_a_tool"'), 
      `Non-tool JSON leaked as text: "${allText}"`);
    assert.ok(!allText.includes('"random_field"'), 
      `Non-tool JSON leaked as text: "${allText}"`);
    assert.ok(allText.includes('prefix'), `prefix lost: "${allText}"`);
    assert.ok(allText.includes('suffix'), `suffix lost: "${allText}"`);
    assert.strictEqual(feedResult.toolCalls.length + flushResult.toolCalls.length, 0);
  });

  it('S3: malformed JSON between valid tool calls does not drop subsequent ones', () => {
    const parser = new StreamingToolParser();
    const input =
      '{"name": "read", "arguments": {"path": "a.txt"}}\n' +
      '{"name": "grep", "arguments": {"pattern": "foo"}}\n' +
      '{"name": "broken" arguments: bad json}\n' +
      '{"name": "write", "arguments": {"path": "b.txt"}}\n' +
      '{"name": "bash", "arguments": {"command": "ls"}}\n';
    const result = parser.feed(input);
    const flush = parser.flush();
    const allCalls = [...result.toolCalls, ...flush.toolCalls];
    assert.strictEqual(allCalls.length, 4,
      `Expected 4 tool calls (malformed #3 dropped, #4+#5 kept). Got: ${JSON.stringify(allCalls.map(t => t.name))}`);
    assert.strictEqual(allCalls[0].name, 'read');
    assert.strictEqual(allCalls[1].name, 'grep');
    assert.strictEqual(allCalls[2].name, 'write');
    assert.strictEqual(allCalls[3].name, 'bash');
  });

  it('S4: streaming chunks split mid-JSON capture all tool calls', () => {
    const parser = new StreamingToolParser();
    const full =
      'Let me check.\n' +
      '{"name": "read", "arguments": {"path": "a.txt"}}\n' +
      '{"name": "grep", "arguments": {"pattern": "foo"}}\n' +
      '{"name": "write", "arguments": {"path": "b.txt", "content": "hello world"}}\n' +
      '{"name": "bash", "arguments": {"command": "ls -la"}}\n' +
      '{"name": "edit", "arguments": {"path": "c.txt", "old": "x", "new": "y"}}\n' +
      'Done.';

    const chunks: string[] = [];
    let i = 0;
    let size = 13;
    while (i < full.length) {
      chunks.push(full.substring(i, i + size));
      i += size;
      size = 10 + ((size * 7) % 31);
    }

    const allCalls: any[] = [];
    let text = '';
    for (const c of chunks) {
      const r = parser.feed(c);
      allCalls.push(...r.toolCalls);
      text += r.text;
    }
    const flush = parser.flush();
    allCalls.push(...flush.toolCalls);
    text += flush.text;

    assert.strictEqual(allCalls.length, 5,
      `Expected 5 tool calls across chunks. Got: ${JSON.stringify(allCalls.map(t => t.name))}`);
    assert.strictEqual(allCalls[0].name, 'read');
    assert.strictEqual(allCalls[1].name, 'grep');
    assert.strictEqual(allCalls[2].name, 'write');
    assert.strictEqual(allCalls[3].name, 'bash');
    assert.strictEqual(allCalls[4].name, 'edit');
    assert.ok(text.includes('Let me check.'));
    assert.ok(text.includes('Done.'));
  });

  it('S5: streaming chunks split single tool call at every possible boundary', () => {
    const json = '{"name": "bash", "arguments": {"command": "ls -la /tmp"}}';
    for (let split = 1; split < json.length; split++) {
      const parser = new StreamingToolParser();
      const r1 = parser.feed(json.substring(0, split));
      const r2 = parser.feed(json.substring(split));
      const flush = parser.flush();
      const allCalls = [...r1.toolCalls, ...r2.toolCalls, ...flush.toolCalls];
      assert.strictEqual(allCalls.length, 1,
        `Split at ${split}: expected 1 tool call, got ${allCalls.length}`);
      assert.strictEqual(allCalls[0].name, 'bash',
        `Split at ${split}: wrong tool name`);
    }
  });

  it('S6: production bug — 4 consecutive bash calls streamed in chunks, all extracted, no text leak', () => {
    // Exact reproduction of the production bug from output-bugs/01.md and 02.md:
    // 4 consecutive bash tool calls arrive as streamed chunks split at arbitrary boundaries.
    // Before fix: only 2 of 4 executed, fragments like `"bash", "` leaked as text.
    // After fix: all 4 extracted with correct arguments, zero text leakage.
    const fullStream = [
      '{"name": "bash", "arguments": {"command": "date", "description": "Show current date"}}',
      '{"name": "bash", "arguments": {"command": "uname -a", "description": "Show system info"}}',
      '{"name": "bash", "arguments": {"command": "whoami", "description": "Show current user"}}',
      '{"name": "bash", "arguments": {"command": "uptime", "description": "Show system uptime"}}',
    ].join('\n');

    // Simulate realistic SSE chunk boundaries — split mid-JSON at various points
    const chunkBoundaries = [
      0,
      45,   // mid-first call: inside "arguments"
      93,   // mid-first call: inside command value
      fullStream.indexOf('\n') + 1,  // right after first call
      fullStream.indexOf('\n') + 30, // mid-second call: inside "name"
      fullStream.indexOf('\n') + 70, // mid-second call: inside "command"
      fullStream.indexOf('\n', fullStream.indexOf('\n') + 1) + 1, // after second call
      fullStream.length - 60, // near end, mid-fourth call
      fullStream.length,
    ];

    const parser = new StreamingToolParser();
    const allCalls: any[] = [];
    let allText = '';
    let prev = 0;

    for (const boundary of chunkBoundaries) {
      if (boundary <= prev) continue;
      const chunk = fullStream.substring(prev, boundary);
      const result = parser.feed(chunk);
      allCalls.push(...result.toolCalls);
      allText += result.text;
      prev = boundary;
    }

    const flushResult = parser.flush();
    allCalls.push(...flushResult.toolCalls);
    allText += flushResult.text;

    // Verify: all 4 tool calls extracted
    assert.strictEqual(allCalls.length, 4,
      `Expected 4 tool calls, got ${allCalls.length}: ${JSON.stringify(allCalls.map(t => t.name))}`);

    // Verify: correct tool names and arguments
    assert.strictEqual(allCalls[0].name, 'bash');
    assert.strictEqual(allCalls[0].arguments.command, 'date');
    assert.strictEqual(allCalls[0].arguments.description, 'Show current date');

    assert.strictEqual(allCalls[1].name, 'bash');
    assert.strictEqual(allCalls[1].arguments.command, 'uname -a');
    assert.strictEqual(allCalls[1].arguments.description, 'Show system info');

    assert.strictEqual(allCalls[2].name, 'bash');
    assert.strictEqual(allCalls[2].arguments.command, 'whoami');
    assert.strictEqual(allCalls[2].arguments.description, 'Show current user');

    assert.strictEqual(allCalls[3].name, 'bash');
    assert.strictEqual(allCalls[3].arguments.command, 'uptime');
    assert.strictEqual(allCalls[3].arguments.description, 'Show system uptime');

    // Verify: NO text leakage — the exact bug symptom
    assert.ok(!allText.includes('"bash"'),
      `Tool name "bash" leaked into text output: "${allText}"`);
    assert.ok(!allText.includes('"arguments"'),
      `JSON key "arguments" leaked into text output: "${allText}"`);
    assert.ok(!allText.includes('"command"'),
      `JSON key "command" leaked into text output: "${allText}"`);
    assert.ok(!allText.includes('bash", "'),
      `Fragment 'bash", "' leaked into text output: "${allText}"`);
  });

  it('S8: exact chunk boundaries from stream-debug-01.log — 5 tools, tool 2 dropped with "bash"," leak', () => {
    const logPath = join(process.cwd(), 'output-bugs', 'log', 'stream-debug-01.log');
    if (!existsSync(logPath)) {
      console.log('Skipping S8: log file not found at', logPath);
      return;
    }

    const logContent = readFileSync(logPath, 'utf-8');
    const rawLines = logContent.split('\n');
    const aiResponseIdx = rawLines.findIndex(l => l.trim() === 'Raw AI Response');
    const chunkLines = aiResponseIdx > 0 ? rawLines.slice(0, aiResponseIdx) : rawLines;
    while (chunkLines.length > 0 && chunkLines[chunkLines.length - 1] === '') {
      chunkLines.pop();
    }

    const parser = new StreamingToolParser();
    const allCalls: any[] = [];
    let allText = '';

    for (const chunk of chunkLines) {
      const result = parser.feed(chunk);
      allCalls.push(...result.toolCalls);
      allText += result.text;
    }

    const flushResult = parser.flush();
    allCalls.push(...flushResult.toolCalls);
    allText += flushResult.text;

    assert.strictEqual(allCalls.length, 5,
      `Expected 5 tool calls, got ${allCalls.length}: ${JSON.stringify(allCalls.map(t => t.name))}. Text leaked: "${allText}"`);

    assert.strictEqual(allCalls[0].name, 'bash');
    assert.strictEqual(allCalls[1].name, 'bash');
    assert.strictEqual(allCalls[2].name, 'bash');
    assert.strictEqual(allCalls[3].name, 'glob');
    assert.strictEqual(allCalls[4].name, 'grep');

    assert.ok(!allText.includes('bash",'),
      `Fragment 'bash",' leaked into text output: "${allText}"`);
  });

  it('S7: streaming with malformed JSON split across chunks preserves surrounding calls', () => {
    const parser = new StreamingToolParser();
    const chunks = [
      '{"name": "read", "arguments": {"path": "a.txt"}}\n',
      '{"name": "broken" ar',
      'guments: bad}\n',
      '{"name": "write", "arguments": {"path": "b.txt"}}\n',
    ];
    const allCalls: any[] = [];
    for (const c of chunks) {
      const r = parser.feed(c);
      allCalls.push(...r.toolCalls);
    }
    const flush = parser.flush();
    allCalls.push(...flush.toolCalls);

    assert.strictEqual(allCalls.length, 2,
      `Expected 2 valid calls (malformed middle dropped). Got: ${JSON.stringify(allCalls.map(t => t.name))}`);
    assert.strictEqual(allCalls[0].name, 'read');
    assert.strictEqual(allCalls[1].name, 'write');
  });

  it('S9: code fences in text output are preserved (no backtick stripping)', () => {
    const parser = new StreamingToolParser();
    const fence = '`' + '`' + '`';
    const chunks = [
      'Here is the code:\n',
      fence + 'typescript\n',
      'const x = 42;\n',
      'console.log(x);\n',
      fence + '\n',
      'And another block:\n',
      fence + '\n',
      'plain code\n',
      fence + '\n',
    ];
    let allText = '';
    for (const c of chunks) {
      const r = parser.feed(c);
      allText += r.text;
    }
    const flush = parser.flush();
    allText += flush.text;

    assert.ok(allText.includes('typescript'),
      'Opening fence with language tag stripped: ' + JSON.stringify(allText));
    assert.ok(allText.includes('const x = 42;'),
      'Code content lost: ' + JSON.stringify(allText));
    const fenceCount = (allText.match(new RegExp(fence, 'g')) || []).length;
    assert.ok(fenceCount >= 4,
      'Expected at least 4 fence markers, got: ' + fenceCount + ' in ' + JSON.stringify(allText));
    assert.strictEqual(flush.toolCalls.length, 0, 'No tool calls expected in pure text');
  });

  it('S10: tool call wrapped in code fence is extracted, fence stripped from text', () => {
    const parser = new StreamingToolParser();
    const fence = '`' + '`' + '`';
    const chunks = [
      'Before text\n',
      fence + 'json\n',
      '{"name": "bash", "arguments": {"command": "ls"}}\n',
      fence + '\n',
      'After text\n',
    ];
    let allText = '';
    const allCalls: any[] = [];
    for (const c of chunks) {
      const r = parser.feed(c);
      allText += r.text;
      allCalls.push(...r.toolCalls);
    }
    const flush = parser.flush();
    allText += flush.text;
    allCalls.push(...flush.toolCalls);

    assert.strictEqual(allCalls.length, 1, 'Expected 1 tool call, got ' + allCalls.length);
    assert.strictEqual(allCalls[0].name, 'bash');
    assert.ok(allText.includes('Before text'), 'Pre-text lost: ' + JSON.stringify(allText));
    assert.ok(allText.includes('After text'), 'Post-text lost: ' + JSON.stringify(allText));
  });

  it('S11: real-life streaming with newlines embedded inside JSON keys, values, and escape sequences', () => {
    // Realistic streaming chunks where newlines split across JSON tokens:
    // - JSON key split mid-name:  "command\n": "..."
    // - String value split mid-shell-command:  "echo \"kernel: $(uname\n -"
    // - Opening brace on different line from key:  {\n"name"
    // - Escape sequences split across lines:  \"\nuptime
    // These exact boundaries were observed in production streaming from Qwen.
    const chunks = [
      // Chunk 1: bash - kernel version
      // "command" key split, inside echo string, shell expansion $() split
      // The \\" represents literal backslash-quote in the streaming JSON output
      '{"name":\n "bash", "\narguments": {"command\n": "echo \\"kernel: $(uname\n -\nr)\\"" , "\ndescription": "Get\n kernel version"}}',

      // Chunk 2: bash - CPU core count
      // "name" value split across lines, "arguments" key split
      '{"name": \n"bash", "arguments\n": {"command":\n "echo \\"cpu\n: $(nproc\n) cores\\"" , "\ndescription": "Get\n CPU core count"}}',

      // Chunk 3: bash - system uptime
      // Shell command chain split, description value split
      '{"name":\n "bash", "\narguments": {"command\n": "echo \\"uptime: $(uptime\n -p 2\n>/dev/null\n || uptime)\\"" ,\n "description": "\nGet system uptime"}}',

      // Chunk 4: glob - find JSON files
      // "pattern" key split, "path" value split
      '{"name":\n "glob", "\narguments": {"pattern\n": "*.json",\n "path": "/\nhome/youssefv\ndel"}}',

      // Chunk 5: grep - search exports
      // Opening brace + key on separate lines, value split mid-string
      '{"\nname": "grep\n", "arguments":\n {"pattern": "^\nexport", "include\n": ".zsh\nrc",\n "path": "/\nhome/youssefv\ndel"}}',
    ];

    const parser = new StreamingToolParser();
    const allCalls: any[] = [];
    let allText = '';

    for (const chunk of chunks) {
      const result = parser.feed(chunk);
      allCalls.push(...result.toolCalls);
      allText += result.text;
    }

    const flushResult = parser.flush();
    allCalls.push(...flushResult.toolCalls);
    allText += flushResult.text;

    // All 5 tool calls must be extracted
    assert.strictEqual(allCalls.length, 5,
      `Expected 5 tool calls, got ${allCalls.length}: ${JSON.stringify(allCalls.map(t => t.name))}`);

    // Tool 1: bash with kernel command
    assert.strictEqual(allCalls[0].name, 'bash',
      `Tool 1: expected 'bash', got '${allCalls[0].name}'`);
    assert.strictEqual(allCalls[0].arguments.command, 'echo "kernel: $(uname -r)"',
      `Tool 1: command mismatch: ${JSON.stringify(allCalls[0].arguments.command)}`);
    assert.strictEqual(allCalls[0].arguments.description, 'Get kernel version',
      `Tool 1: description mismatch: ${JSON.stringify(allCalls[0].arguments.description)}`);

    // Tool 2: bash with CPU cores command
    assert.strictEqual(allCalls[1].name, 'bash',
      `Tool 2: expected 'bash', got '${allCalls[1].name}'`);
    assert.strictEqual(allCalls[1].arguments.command, 'echo "cpu: $(nproc) cores"',
      `Tool 2: command mismatch: ${JSON.stringify(allCalls[1].arguments.command)}`);
    assert.strictEqual(allCalls[1].arguments.description, 'Get CPU core count',
      `Tool 2: description mismatch: ${JSON.stringify(allCalls[1].arguments.description)}`);

    // Tool 3: bash with uptime command (complex shell chain)
    assert.strictEqual(allCalls[2].name, 'bash',
      `Tool 3: expected 'bash', got '${allCalls[2].name}'`);
    assert.strictEqual(allCalls[2].arguments.command, 'echo "uptime: $(uptime -p 2>/dev/null || uptime)"',
      `Tool 3: command mismatch: ${JSON.stringify(allCalls[2].arguments.command)}`);
    assert.strictEqual(allCalls[2].arguments.description, 'Get system uptime',
      `Tool 3: description mismatch: ${JSON.stringify(allCalls[2].arguments.description)}`);

    // Tool 4: glob with pattern and path
    assert.strictEqual(allCalls[3].name, 'glob',
      `Tool 4: expected 'glob', got '${allCalls[3].name}'`);
    assert.strictEqual(allCalls[3].arguments.pattern, '*.json',
      `Tool 4: pattern mismatch: ${JSON.stringify(allCalls[3].arguments.pattern)}`);
    assert.strictEqual(allCalls[3].arguments.path, '/home/youssefvdel',
      `Tool 4: path mismatch: ${JSON.stringify(allCalls[3].arguments.path)}`);

    // Tool 5: grep with pattern, include, and path
    assert.strictEqual(allCalls[4].name, 'grep',
      `Tool 5: expected 'grep', got '${allCalls[4].name}'`);
    assert.strictEqual(allCalls[4].arguments.pattern, '^export',
      `Tool 5: pattern mismatch: ${JSON.stringify(allCalls[4].arguments.pattern)}`);
    assert.strictEqual(allCalls[4].arguments.include, '.zshrc',
      `Tool 5: include mismatch: ${JSON.stringify(allCalls[4].arguments.include)}`);
    assert.strictEqual(allCalls[4].arguments.path, '/home/youssefvdel',
      `Tool 5: path mismatch: ${JSON.stringify(allCalls[4].arguments.path)}`);

    // No text leakage: JSON fragments should NOT leak as text
    // The newlines between chunks are expected text output but JSON keys/values are not
    assert.ok(!allText.includes('bash",'),
      `Fragment 'bash",' leaked as text: ${JSON.stringify(allText)}`);
    assert.ok(!allText.includes('arguments":'),
      `Fragment 'arguments":' leaked as text: ${JSON.stringify(allText)}`);
    assert.ok(!allText.includes('"command"'),
      `JSON key 'command' leaked as text: ${JSON.stringify(allText)}`);
    // 'description' may legitimately appear in the text output but as a JSON key it should not
    assert.ok(!allText.includes('"description"'),
      `JSON key 'description' leaked as text: ${JSON.stringify(allText)}`);
  });
});
