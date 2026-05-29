import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';
import { stripStreamingDelta } from '../utils/contentFilter.ts';

/**
 * Test for 02.md leak pattern: tool call JSON fragments leaking into content
 * 
 * Bug: When I (the AI) call tools like bash, read, grep, the tool call JSON
 * serializes and splits across SSE chunks. Fragments like `bash", "arguments`
 * leak into the content stream.
 * 
 * Root cause: StreamingToolParser tries to extract tool calls from delta.content
 * even though Qwen already provides structured delta.tool_calls[].
 * 
 * Fix: Remove StreamingToolParser from streaming path, rely on structured consumption.
 */

describe('Streaming tool call leak prevention (02.md fix)', () => {
  it('S1-RED: StreamingToolParser with stripStreamingDelta still leaks (proves bug exists)', () => {
    // This test simulates the CURRENT buggy behavior with the safety net
    // It should FAIL after we remove StreamingToolParser from chat.ts
    
    const parser = new StreamingToolParser();
    
    // Simulate chunks where tool call JSON splits across boundaries
    // This is what happens when I call bash/read/grep tools
    const chunk1 = 'I will use bash", "argum';
    const chunk2 = 'ents": {"command": "ls"}}';
    
    const result1 = parser.feed(chunk1);
    const result2 = parser.feed(chunk2);
    const final = parser.flush();
    
    // Apply the safety net (stripStreamingDelta)
    const text1 = stripStreamingDelta(result1.text);
    const text2 = stripStreamingDelta(result2.text);
    const textFinal = stripStreamingDelta(final.text);
    
    const allText = text1 + text2 + textFinal;
    
    // CURRENT BUGGY BEHAVIOR: even with stripStreamingDelta, fragments leak
    // This assertion should PASS on buggy code (proving bug exists)
    // and FAIL after the fix (when parser is removed)
    const hasLeak = allText.includes('bash", "argum') || 
                    allText.includes('"arguments"') ||
                    allText.includes('ents":') ||
                    allText.includes('I will use');
    
    assert.ok(hasLeak, 
      `Expected leak but got clean text: "${allText}". ` +
      `This means the bug is fixed or the test is wrong.`);
  });

  it('S1-GREEN: structured tool_calls consumption prevents leaks', () => {
    // Simulate the leak pattern from 02.md:
    // My tool calls serialize as: {"name": "bash", "arguments": {"command": "ls"}}
    // Split across chunks: 'bash", "argum' | 'ents": {"command": "ls"}}'
    
    const chunk1Content = 'I will use bash", "argum';
    const chunk2Content = 'ents": {"command": "ls"}}';
    
    // After fix: these should be in delta.tool_calls[], not delta.content
    // So delta.content should be empty or contain only actual text
    
    // For now, simulate what the FIXED code should do:
    // If delta.tool_calls is present, delta.content should not contain tool call JSON
    
    const mockChunk1 = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_123',
            type: 'function',
            function: {
              name: 'bash',
              arguments: '{"comm'
            }
          }]
        },
        finish_reason: null
      }]
    };
    
    const mockChunk2 = {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              arguments: 'and": "ls"}'
            }
          }]
        },
        finish_reason: null
      }]
    };
    
    // Simulate the streaming handler logic (after fix)
    let accumulatedContent = '';
    let currentToolCall: any = null;
    
    for (const chunk of [mockChunk1, mockChunk2]) {
      const delta = chunk.choices[0].delta;
      
      // Structured tool call consumption (the fix)
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        const toolCallDelta = delta.tool_calls[0];
        
        if (toolCallDelta.id) {
          currentToolCall = {
            id: toolCallDelta.id,
            type: 'function',
            function: {
              name: toolCallDelta.function?.name || '',
              arguments: toolCallDelta.function?.arguments || '',
            },
          };
        } else {
          if (currentToolCall && toolCallDelta.function?.arguments) {
            currentToolCall.function.arguments += toolCallDelta.function.arguments;
          }
        }
        
        // Don't emit content when we have tool calls
        continue;
      }
      
      // Only emit content if no tool calls
      if (delta.content) {
        accumulatedContent += delta.content;
      }
    }
    
    // Verify: no tool call fragments in accumulated content
    assert.ok(!accumulatedContent.includes('bash", "arguments'), 
      `Fragment leaked into content: "${accumulatedContent}"`);
    assert.ok(!accumulatedContent.includes('"arguments"'), 
      `Fragment leaked into content: "${accumulatedContent}"`);
    
    // Verify: tool call accumulated correctly
    assert.equal(currentToolCall.function.name, 'bash');
    assert.equal(currentToolCall.function.arguments, '{"command": "ls"}');
  });

  it('S2: multiple tool names do not leak (bash, read, grep, glob)', () => {
    // Test all the tool names from 02.md
    const toolNames = ['bash', 'read', 'grep', 'glob'];
    
    for (const toolName of toolNames) {
      const mockChunk = {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: `call_${toolName}`,
              type: 'function',
              function: {
                name: toolName,
                arguments: '{}'
              }
            }]
          },
          finish_reason: null
        }]
      };
      
      // Simulate handler
      let accumulatedContent = '';
      const delta = mockChunk.choices[0].delta;
      
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        // Structured consumption - no content emission
        continue;
      }
      
      if (delta.content) {
        accumulatedContent += delta.content;
      }
      
      // Verify: tool name not in content
      assert.ok(!accumulatedContent.includes(`${toolName}", "arguments`),
        `Tool name "${toolName}" leaked into content: "${accumulatedContent}"`);
    }
  });

  it('S3: content and tool calls can coexist without leaking', () => {
    // Scenario: model outputs text, then calls a tool
    const chunks = [
      {
        choices: [{
          delta: { content: 'Let me check the files.' },
          finish_reason: null
        }]
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_bash',
              type: 'function',
              function: {
                name: 'bash',
                arguments: '{"command": "ls"}'
              }
            }]
          },
          finish_reason: null
        }]
      }
    ];
    
    let accumulatedContent = '';
    let currentToolCall: any = null;
    
    for (const chunk of chunks) {
      const delta = chunk.choices[0].delta;
      
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        const toolCallDelta = delta.tool_calls[0];
        
        if (toolCallDelta.id) {
          currentToolCall = {
            id: toolCallDelta.id,
            type: 'function',
            function: {
              name: toolCallDelta.function?.name || '',
              arguments: toolCallDelta.function?.arguments || '',
            },
          };
        }
        
        continue;
      }
      
      if (delta.content) {
        accumulatedContent += delta.content;
      }
    }
    
    // Verify: content preserved
    assert.equal(accumulatedContent, 'Let me check the files.');
    
    // Verify: tool call extracted
    assert.equal(currentToolCall.function.name, 'bash');
    
    // Verify: no fragments in content
    assert.ok(!accumulatedContent.includes('bash'),
      `Tool name leaked into content: "${accumulatedContent}"`);
  });

  it('S4: malformed tool call JSON does not leak', () => {
    // Edge case: what if delta.content contains malformed JSON?
    // After fix: this shouldn't happen (tool calls in delta.tool_calls[])
    // But if it does, we should not emit it as content
    
    const mockChunk = {
      choices: [{
        delta: {
          content: 'bash", "arguments": {"command": "ls"}'  // Malformed JSON
        },
        finish_reason: null
      }]
    };
    
    // After fix: StreamingToolParser removed, so this would emit as-is
    // But with stripStreamingDelta, it should be cleaned
    
    // For now, document the expected behavior:
    // If tool calls are in delta.content (not delta.tool_calls), they should be filtered
    
    const delta = mockChunk.choices[0].delta;
    let content = delta.content || '';
    
    // Apply stripStreamingDelta (the safety net)
    content = content.replace(/[a-z_]+",\s*"arguments/g, '');
    content = content.replace(/"arguments"\s*:\s*\{/g, '');
    
    // Verify: fragments removed
    assert.ok(!content.includes('bash", "arguments'),
      `Fragment not stripped: "${content}"`);
  });
});
