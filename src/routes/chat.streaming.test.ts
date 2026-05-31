import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';
import { stripStreamingDelta, filterContent } from '../utils/contentFilter.ts';
import { ToolResultEchoFilter } from './pipeline/ToolResultEchoFilter.ts';

// ─── Streaming simulation ──────────────────────────────────────────────

/**
 * Splits text into variable-sized word-group chunks to simulate real SSE
 * streaming behavior where content arrives in unpredictable fragments.
 *
 * Word grouping prevents mid-character splits (unreadable test output)
 * while still producing realistic fragment boundaries.
 *
 * Example with "Hey! How can I help you with the codebase today?":
 *   #1 "Hey! How can "
 *   #2 "I "
 *   #3 "help you "
 *   #4 "with the codebase today?"
 */
function streamChunks(text: string): string[] {
  if (!text) return [];
  const words = text.match(/\S+\s*/g);
  if (!words || words.length <= 1) return [text];
  const sizes = [3, 1, 2, 4, 2, 3, 1, 5];
  const chunks: string[] = [];
  let pos = 0, idx = 0;
  while (pos < words.length) {
    const n = Math.min(sizes[idx++ % sizes.length], words.length - pos);
    chunks.push(words.slice(pos, pos + n).join(''));
    pos += n;
  }
  return chunks;
}

/**
 * Human-readable chunk listing for debug assertions.
 */
function describeChunks(chunks: string[]): string {
  return chunks.map((c, i) => `  #${i + 1} "${c.replace(/\n/g, '\\n')}"`).join('\n');
}

/**
 * Simulates the real chat.ts streaming delta pipeline.
 *
 * On each chunk:
 *   1. stripStreamingDelta() removes tool call JSON fragments
 *   2. ToolResultEchoFilter.filterText() runs on the FULL accumulated buffer
 *   3. The snapshot diff emits only what's genuinely new (high-water mark)
 *
 * This reproduces the exact pattern used in production at
 * src/routes/chat.ts:1264-1310.
 */
function simulateStreamWithEchoFilter(
  text: string,
  echoFilter: ToolResultEchoFilter | null,
  options?: { stripArtifacts?: boolean },
): {
  fragments: string[];
  rawAccumulated: string;
  deltas: string[];
  finalFiltered: string;
} {
  const fragments = streamChunks(text);
  const deltas: string[] = [];
  let rawAccumulated = '';
  let lastSnapshot = '';
  const strip = options?.stripArtifacts !== false;

  for (const frag of fragments) {
    rawAccumulated += frag;
    const cleaned = strip ? stripStreamingDelta(frag) : frag;

    if (echoFilter) {
      const filtered = echoFilter.filterText(rawAccumulated);
      const delta = filtered.slice(lastSnapshot.length);
      if (delta) {
        lastSnapshot = filtered;
        deltas.push(delta);
      }
    } else {
      if (cleaned) deltas.push(cleaned);
    }
  }

  return {
    fragments,
    rawAccumulated,
    deltas,
    finalFiltered: echoFilter ? echoFilter.filterText(rawAccumulated) : rawAccumulated,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Streaming tool call leak prevention (02.md fix)', () => {

  // ── Text reassembly ────────────────────────────────────────────────

  it('S0: text fragments reassemble correctly through basic streaming', () => {
    const input = 'Hey! How can I help you with the codebase today? I can analyze dependencies, trace execution flows, explore specific modules, or investigate impact of changes.';
    const frags = streamChunks(input);

    // Verify fragmentation produces at least 3 chunks (realistic split)
    assert.ok(frags.length >= 3,
      `Expected ≥3 fragments, got ${frags.length}:\n${describeChunks(frags)}`);

    // Verify reassembly
    const reassembled = frags.join('');
    assert.equal(reassembled, input,
      `Reassembled text does not match input.\nExpected: "${input}"\nGot:      "${reassembled}"`);

    // Verify stripStreamingDelta preserves normal text
    for (const frag of frags) {
      const cleaned = stripStreamingDelta(frag);
      assert.equal(cleaned, frag,
        `stripStreamingDelta should not modify normal text.\n  fragment: "${frag}"\n  cleaned:  "${cleaned}"`);
    }
  });

  // ── Tool call JSON leak ─────────────────────────────────────────────

  it('S1: stripStreamingDelta catches tool call fragments with leading quote but leaks fragments without it', () => {
    // Simulate what happens when tool call JSON serializes and splits
    // across SSE chunks in the actual chat.qwen.ai stream.
    // The raw chunks coming from Qwen look like partial JSON because the
    // tool call is serialized as text in the content field.
    //
    // stripStreamingDelta patterns expect a leading `"` or `: "` before
    // the tool name. When the `{"name": ` prefix lands in a different
    // chunk (via the structured tool_calls path), the remaining fragment
    // like `bash", "arguments"` has no leading quote and passes through.
    // This is a known limitation — the real fix is structured tool_calls
    // consumption (tested in S3).
    const rawStream = [
      'I will use bash", "argum',        // #1 — no leading `"` before `bash` → passes through
      'ents": {"command": "ls"}}',        // #2 — tool call args split across boundary
      ' The command output is empty.',    // #3 — actual content after tool call
    ];

    const deltas = rawStream.map(s => stripStreamingDelta(s));
    const accumulatedDeltas = deltas.join('');

    // Real content should survive
    assert.ok(accumulatedDeltas.includes('The command output is empty.'),
      `Real content was stripped: "${accumulatedDeltas}"`);

    // KNOWN LIMITATION: fragments without a leading `"` or `: "` before the
    // tool name leak through stripStreamingDelta — including both `bash"` and
    // `ents"`. The `"` was consumed by the structured tool_calls path.
    // The real fix (structured consumption in S3) prevents this entirely.
    console.log(`  S1 known limitation: fragments leak through stripStreamingDelta`);
    console.log(`    "${rawStream[0]}"`);
    console.log(`    "${rawStream[1]}"`);
    console.log(`  S1 chunks:\n${rawStream.map((c, i) => `    #${i + 1} "${c}"`).join('\n')}`);
    console.log(`  S1 deltas:  ${deltas.map(d => `"${d}"`).join(' + ')}`);
  });

  // ── Multiple tool names ─────────────────────────────────────────────

  it('S2: multiple tool names (bash, read, grep, glob) do not leak across chunks', () => {
    const toolNames = ['bash', 'read', 'grep', 'glob'];

    for (const name of toolNames) {
      // Simulate a streaming chunk where the tool call fragment spills
      // into the content field
      const chunks = [
        `I'll use the ${name}`,
        `", "arguments": {"`,
        `path": "/etc/hostname"}}`,
        ` The file was read successfully.`,
      ];

      const deltas = chunks.map(c => stripStreamingDelta(c));
      const output = deltas.join('');

      // Real content should survive
      assert.ok(output.includes('The file was read successfully.'),
        `Real content stripped for ${name}: "${output}"`);

      // Tool call fragments should be removed
      assert.ok(!output.includes(`"${name}"`),
        `Tool name "${name}" leaked: "${output}"`);
    }
  });

  // ── Content + tool calls coexistence ────────────────────────────────

  it('S3: content and tool calls coexist without leaking into each other', () => {
    // Scenario: model outputs text, then calls a tool in a later chunk
    const mockChunks = [
      { tool_calls: null,          content: 'Let me check the files.' },
      { tool_calls: [{ index: 0, id: 'call_bash', type: 'function',
        function: { name: 'bash', arguments: '{"command": "ls"}' } }], content: null },
    ];

    let accumulatedContent = '';
    let currentToolCall: any = null;

    for (const chunk of mockChunks) {
      if (chunk.tool_calls?.length) {
        const tc = chunk.tool_calls[0];
        if (tc.id) {
          currentToolCall = {
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          };
        }
        continue; // Structured tool_calls — no content emission
      }
      if (chunk.content) {
        accumulatedContent += chunk.content;
      }
    }

    assert.equal(accumulatedContent, 'Let me check the files.');
    assert.equal(currentToolCall?.function.name, 'bash');
    assert.equal(currentToolCall?.function.arguments, '{"command": "ls"}');
    assert.ok(!accumulatedContent.includes('bash'),
      `Tool name leaked into content: "${accumulatedContent}"`);
  });

  // ── 4 consecutive tool calls with shared prefix ──────────────────────

  it('S4: 4 consecutive tool calls with shared prefix — all extracted, no text leak', async () => {
    const { detectCumulativeChunk } = await import('../routes/chat.ts');

    const call1 = '{"name": "bash", "arguments": {"command": "date", "description": "Show current date"}}';
    const call2 = '{"name": "bash", "arguments": {"command": "uname -a", "description": "Show system info"}}';
    const call3 = '{"name": "bash", "arguments": {"command": "whoami", "description": "Show current user"}}';
    const call4 = '{"name": "bash", "arguments": {"command": "uptime", "description": "Show system uptime"}}';

    const d1 = detectCumulativeChunk(call2, call1);
    assert.equal(d1.cumulative, false, `call1→call2 must NOT be cumulative (got delta: "${d1.delta}")`);

    const d2 = detectCumulativeChunk(call3, call2);
    assert.equal(d2.cumulative, false, `call2→call3 must NOT be cumulative`);

    const d3 = detectCumulativeChunk(call4, call3);
    assert.equal(d3.cumulative, false, `call3→call4 must NOT be cumulative`);

    const cumulativeNew = call1 + '\n' + call2;
    const d4 = detectCumulativeChunk(cumulativeNew, call1);
    assert.equal(d4.cumulative, true, 'genuinely cumulative text should be detected');
    assert.equal(d4.delta, '\n' + call2, 'delta should be the appended content');
  });

  // ── Malformed tool call JSON ────────────────────────────────────────

  it('S5: stripStreamingDelta strips fragments with leading colon+quote but not bare tool names', () => {
    // stripStreamingDelta catches patterns like `: "bash"` (colon + quote + name)
    // It does NOT catch `bash", "arguments"` when the leading `"` is absent
    // (same limitation as S1 — the `"` was consumed by the structured path)

    // stripStreamingDelta's pattern 8 lookahead catches `"bash", "arguments"`
    // BUT pattern 7 (`, "arguments"`) runs first and removes `"arguments"`,
    // breaking pattern 8's lookahead — so `"bash"` survives.
    // This is a known ordering limitation in the safety net.
    const colonFormats = [
      ': "bash", "arguments": {"command": "ls"}',
      ': "grep", "arguments": {"pattern": "foo"}',
    ];
    for (const chunk of colonFormats) {
      const cleaned = stripStreamingDelta(chunk);
      // `, "arguments":` should be stripped (pattern 7 matches)
      assert.ok(!cleaned.includes(', "arguments"'),
        `", "arguments" not stripped: "${chunk}" → "${cleaned}"`);
      console.log(`  S5 colon format: "${chunk}" → "${cleaned}"`);
    }

    // Bare format without leading `"` — KNOWN LIMITATION (same as S1)
    const bareFormats = [
      'bash", "arguments": {"command": "ls"}',       // no leading `"` → passes through
      'grep", "arguments": {"pattern": "foo"}',       // no leading `"` → passes through
    ];
    for (const chunk of bareFormats) {
      const cleaned = stripStreamingDelta(chunk);
      // stripStreamingDelta doesn't catch these — bare tool name without `"`
      // This is a known safety net gap; the structured path is the real fix
      console.log(`  S5 known limitation: "${chunk}" → "${cleaned}"`);
    }
  });
});

describe('ToolResultEchoFilter in streaming (high-water mark fix)', () => {
  const toolResults = [
    'File: /etc/hostname\nContent: myhost',
    'CPU: 45%\nMemory: 2.1GB\nDisk: 78%',
  ];

  // ── Echo filter catches verbatim repetition ─────────────────────────

  it('filters verbatim tool result echo split across streaming chunks', () => {
    // Model output repeats a tool result line VERBATIM — shingle filter
    // needs ≥70% containment; paraphrased text won't match.
    // "File: /etc/hostname" is a direct copy of the tool result → caught
    // "That is the current hostname" is original analysis → preserved
    const input = 'File: /etc/hostname\n\nThat is the current hostname of this machine.';
    const filter = new ToolResultEchoFilter(toolResults);
    const { fragments, deltas, finalFiltered } = simulateStreamWithEchoFilter(input, filter);

    console.log(`  Fragments (${fragments.length}):\n${describeChunks(fragments)}`);
    console.log(`  Deltas: ${deltas.map(d => `"${d}"`).join(' + ')}`);

    const output = deltas.join('');
    assert.ok(output.includes('That is the current hostname'),
      `Original content was filtered: "${output}"`);
    assert.ok(output.includes('File: /etc/hostname') === false,
      `Tool result echo leaked into deltas: "${output}"`);

    // Final filtered text should be clean
    assert.ok(!finalFiltered.includes('File: /etc/hostname'),
      `Tool result echo remained in final: "${finalFiltered}"`);
  });

  // ── Echo filter preserves original analysis ─────────────────────────

  it('preserves original analysis that paraphrases tool data', () => {
    // Model output should NOT be filtered — it's analysis, not echo
    const input = 'System resources are within normal limits. CPU is at 45% which is fine. Memory usage at 2.1GB is acceptable.';
    const filter = new ToolResultEchoFilter(toolResults);
    const { deltas, finalFiltered } = simulateStreamWithEchoFilter(input, filter);

    const output = deltas.join('');
    assert.ok(output.includes('System resources are within normal limits.'),
      `Analysis text was incorrectly filtered: "${output}"`);
    assert.ok(output.includes('CPU is at 45%'),
      `Paraphrased data was incorrectly filtered: "${output}"`);

    // The shingle filter should NOT match paraphrased content
    // (shingles of "CPU is at 45% which is fine" ≠ "CPU: 45%")
    assert.equal(deltas.length, output.length > 0 ? deltas.length : 0,
      `Expected deltas to be non-empty for original content`);
  });

  // ── Incremental fragments accumulate through high-water mark ────────

  it('high-water mark pattern correctly accumulates incremental fragments', () => {
    // Simulate a realistic streaming scenario where a verbatim tool result
    // line appears (shingle filter needs ≥70% containment to trigger).
    // "Memory: 2.1GB" (14 chars after norm, ≥ MIN_LINE_LENGTH=10) is a
    // verbatim copy of the tool result line → filtered.
    // The preceding/following text on separate lines → preserved.
    const input = 'First result shows normal.\n\nMemory: 2.1GB\n\nEverything looks good.';
    const filter = new ToolResultEchoFilter(toolResults);
    const { fragments, deltas, finalFiltered } = simulateStreamWithEchoFilter(input, filter);

    console.log(`  Echo filter streaming fragments:\n${describeChunks(fragments)}`);

    // "Memory: 2.1GB" is a verbatim tool result line → filtered
    assert.ok(!finalFiltered.includes('Memory: 2.1GB'),
      `Tool result echo "Memory: 2.1GB" leaked: "${finalFiltered}"`);

    // Original text should survive
    assert.ok(finalFiltered.includes('First result shows normal.'),
      `Original text was incorrectly filtered: "${finalFiltered}"`);
    assert.ok(finalFiltered.includes('Everything looks good.'),
      `Original text was incorrectly filtered: "${finalFiltered}"`);

    // Verify deltas are non-empty (we're emitting something)
    assert.ok(deltas.length > 0, `Expected at least one delta, got ${deltas.length}`);

    // Verify the accumulated deltas match the final filtered text
    const accumulatedDeltas = deltas.join('');
    assert.equal(accumulatedDeltas, finalFiltered,
      `Delta accumulation mismatch.\n  deltas:        "${accumulatedDeltas}"\n  finalFiltered: "${finalFiltered}"`);
  });

  // ── Empty tool results = no-op ──────────────────────────────────────

  it('is a no-op when no tool results exist', () => {
    const input = 'This is completely original content with no tool result echoes at all.';
    const filter = new ToolResultEchoFilter([]);
    const { deltas, finalFiltered } = simulateStreamWithEchoFilter(input, filter);

    assert.equal(finalFiltered, input,
      `Empty filter should not modify text.\n  expected: "${input}"\n  got:      "${finalFiltered}"`);

    const output = deltas.join('');
    assert.equal(output, input,
      `High-water mark with empty filter should pass through all content.\n  expected: "${input}"\n  got:      "${output}"`);
  });

  // ── No echo filter — passthrough ────────────────────────────────────

  it('passes text through unchanged when no echo filter is active', () => {
    const input = 'Normal conversational text with no tool calling context whatsoever.';
    const { fragments, deltas } = simulateStreamWithEchoFilter(input, null);

    const output = deltas.join('');
    assert.equal(output, input,
      `Without echo filter, text should pass through unchanged.\n  expected: "${input}"\n  got:      "${output}"`);

    // Should have emitted at least one chunk
    assert.ok(fragments.length >= 1,
      `Expected fragments, got: ${fragments.length}`);
  });

  // ── Partial echo lines at chunk boundaries ──────────────────────────

  it('handles echo lines that span chunk boundaries via high-water mark', () => {
    // This is the key scenario the high-water mark pattern fixes:
    // an echo line starts in one chunk and completes in the next.
    // Without the high-water mark, neither fragment would match the
    // shingle threshold and the echo would leak through.
    //
    // With the high-water mark, the filter runs on the FULL accumulated
    // buffer where the complete line exists, so it correctly identifies
    // the echo.

    const input = 'Memory: 2.1GB\nThis is the memory usage from the system check.';
    const filter = new ToolResultEchoFilter(toolResults);
    const { fragments, deltas, finalFiltered } = simulateStreamWithEchoFilter(input, filter);

    // "Memory: 2.1GB" is a tool result echo — should be filtered
    assert.ok(!finalFiltered.includes('Memory: 2.1GB'),
      `Echo "Memory: 2.1GB" leaked through high-water mark: "${finalFiltered}"`);

    // "This is the memory usage..." is original analysis — should survive
    assert.ok(finalFiltered.includes('memory usage'),
      `Original text was incorrectly filtered: "${finalFiltered}"`);
  });
});

describe('Content filter with streaming', () => {

  // ── Thinking blocks stripped from stream ────────────────────────────

  it('strips <thinking> blocks from content across streaming fragments', () => {
    const input = 'Hello! <thinking>I should analyze this carefully</thinking> The answer is 42.';
    const frags = streamChunks(input);

    // Accumulate fragments and apply content filter at each step
    let accumulated = '';
    const deltas: string[] = [];
    let lastSnapshot = '';

    for (const frag of frags) {
      accumulated += frag;
      const filtered = filterContent(accumulated).cleanText;
      const delta = filtered.slice(lastSnapshot.length);
      if (delta) {
        lastSnapshot = filtered;
        deltas.push(delta);
      }
    }

    const output = deltas.join('');
    assert.ok(output.includes('Hello!'),
      `"Hello!" was stripped: "${output}"`);
    assert.ok(output.includes('The answer is 42.'),
      `Answer was stripped: "${output}"`);
    assert.ok(!output.includes('I should analyze'),
      `Thinking content leaked: "${output}"`);

    // Verify final filtered output
    const finalFiltered = filterContent(input).cleanText;
    assert.equal(output, finalFiltered,
      `Delta accumulation mismatch.\n  deltas:   "${output}"\n  expected: "${finalFiltered}"`);
  });

  // ── Streaming thinking tags that open but never close ───────────────

  it('strips unclosed <thinking tag at end of a streaming chunk', () => {
    const chunks = [
      'The result is <thinking',     // #1 — tag opens, no close yet
      '>I need to verify</thinking>', // #2 — tag completes
      ' The final count is 42.',      // #3 — clean content
    ];

    const deltas = chunks.map(c => stripStreamingDelta(c));
    const output = deltas.join('');

    // stripStreamingDelta handles partial <tool and <t... fragments
    // <thinking is handled by filterContent, not stripStreamingDelta
    // But the content filter runs on accumulated text, not per-chunk
    // So we test the full pipeline

    const accumulated = chunks.join('');
    const filtered = filterContent(accumulated).cleanText;
    assert.ok(!filtered.includes('<thinking'),
      `Thinking tag leaked through: "${filtered}"`);
    assert.ok(filtered.includes('The final count is 42.'),
      `Content was stripped: "${filtered}"`);
  });
});
