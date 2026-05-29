import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
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
});
