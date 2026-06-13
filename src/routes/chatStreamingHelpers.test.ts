import test, { describe } from 'node:test';
import assert from 'node:assert';
import { processStreamData, type StreamProcessingState, type StreamProcessingCtx } from './chatStreamingHelpers.ts';
import { logStore } from '../services/logStore.ts';

test('reproduces and tests fix for corrupted tool call when split across chunks', async () => {
  const logId = 'test-corrupted-tool-call-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

  const state: StreamProcessingState = {
    targetResponseId: null,
    nextParentId: null,
    completionTokens: 0,
    promptTokens: 0,
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    deferredThinkingChunks: [],
    lastFullContent: '',
    lastRawContent: '',
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
  };

  const writtenEvents: string[] = [];
  const mockStreamWriter = {
    write: async (chunk: string) => {
      writtenEvents.push(chunk);
    }
  };

  const ctx: StreamProcessingCtx = {
    streamWriter: mockStreamWriter,
    completionId: 'test-completion-id',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: true,
    logId: logId,
    resolvedEmail: 'test@example.com',
    ampState: {
      rawInputBytes: 0,
      emittedOutputBytes: 0,
      triggered: false,
    },
    qwenAbortController: new AbortController(),
  };

  const chunks = [
    "Both",
    " files now set `",
    "thinking_format: \"",
    "full\"`.\n\n",
    "Now let me also",
    " add the thinking_format",
    " to the log",
    " files as you asked",
    " earlier, and restart",
    " the gateway.\n",
    "<function=★",
    "-edit",
    ">\n<parameter",
    "=filePath>\n",
    "/home/youssefv",
    "del/Projects/q",
    "wen-gate/src",
    "/services/logStore.ts",
    "\n</parameter>",
    "\n<parameter=",
    "oldString>\n",
    "  thinkingContent?:",
    " string;\n ",
    " amplificationTriggered",
    "Input?: string |",
    " null;\n</",
    "parameter>\n",
    "<parameter=newString>",
    "\n  thinkingContent",
    "?: string;\n",
    "  thinkingFormat?:",
    " string;\n ",
    " amplificationTriggered",
    "Input?: string |",
    " null;\n</",
    "parameter>\n</",
    "function>\n"
  ];

  for (const chunk of chunks) {
    const data = {
      choices: [
        {
          delta: {
            phase: 'answer',
            content: chunk
          }
        }
      ]
    };
    await processStreamData(data, state, ctx);
  }

  // 1. Verify that the tool call was successfully parsed and recorded in the logStore entry
  const logEntry = (logStore as any).entryMap.get(logId);
  assert.ok(logEntry, 'log entry should exist');
  assert.strictEqual(logEntry.parsedToolCalls.length, 1, 'should have parsed exactly one tool call');
  assert.strictEqual(logEntry.parsedToolCalls[0].name, '★-edit', 'tool call name should be ★-edit');

  // 2. Verify that the emitted tool call event is sent to the client
  const toolCallEvents = writtenEvents.filter(e => e.includes('tool_calls'));
  assert.strictEqual(toolCallEvents.length, 1, 'should have emitted exactly one tool call event to client');
  assert.ok(toolCallEvents[0].includes('★-edit') || toolCallEvents[0].includes('edit'), 'emitted tool call should be edit');

  // 3. Verify that the content streamed to the client does NOT contain leaked function tags/parameters
  // Reconstruct emitted content from content events
  const contentEvents = writtenEvents.filter(e => !e.includes('tool_calls') && e.includes('"content"'));
  let reconstructedContent = '';
  for (const event of contentEvents) {
    // Extract JSON payload from SSE "data: <json>\n\n"
    const match = event.match(/^data: (\{.*\})\n\n$/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      const content = parsed.choices[0].delta.content;
      if (content) reconstructedContent += content;
    }
  }

  // Ensure that no function/parameter tags or leaked fragments (-edit, filePath, etc.) are present in content
  assert.ok(!reconstructedContent.includes('<function='), 'should not leak function tag');
  assert.ok(!reconstructedContent.includes('edit'), 'should not leak tool name edit in content');
  assert.ok(!reconstructedContent.includes('filePath'), 'should not leak parameter filePath in content');
  assert.ok(!reconstructedContent.includes('oldString'), 'should not leak parameter oldString in content');
  assert.ok(!reconstructedContent.includes('newString'), 'should not leak parameter newString in content');
});
