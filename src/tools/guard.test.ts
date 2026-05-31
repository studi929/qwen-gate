import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateToolCalls, validateSingleToolCall, detectToolCallLoop, detectParallelToolLoop } from './guard.ts';
import type { ParsedToolCall } from './types.ts';

describe('validateToolCalls', () => {
  it('should accept valid tool calls', () => {
    const toolCall: ParsedToolCall = { id: 'test1', name: 'search', arguments: { query: 'hello' } };
    const result = validateToolCalls([toolCall]);
    assert.ok(result.ok, 'Valid tool call should pass');
    assert.strictEqual(result.valid.length, 1);
  });

  it('should reject tool call with missing name', () => {
    const toolCall: ParsedToolCall = { id: 'test2', name: '', arguments: {} };
    const result = validateToolCalls([toolCall]);
    assert.ok(!result.ok, 'Empty name should fail');
    assert.ok(result.errors.some(e => e.includes('name')));
  });

  it('should reject tool call with missing arguments', () => {
    const toolCall: ParsedToolCall = { id: 'test3', name: 'search', arguments: undefined as any };
    const result = validateToolCalls([toolCall]);
    assert.ok(!result.ok, 'Missing arguments should fail');
    assert.ok(result.errors.some(e => e.includes('arguments')));
  });

  it('should handle empty array', () => {
    const result = validateToolCalls([]);
    assert.ok(result.ok, 'Empty array should pass');
    assert.strictEqual(result.valid.length, 0);
  });

  it('should reject non-array input', () => {
    const result = validateToolCalls(null as any);
    assert.ok(!result.ok, 'Non-array should fail');
    assert.ok(result.errors.some(e => e.includes('array')));
  });
});

describe('validateSingleToolCall', () => {
  it('should accept valid single tool call', () => {
    const toolCall: ParsedToolCall = { id: 'single', name: 'test', arguments: {} };
    const result = validateSingleToolCall(toolCall);
    assert.ok(result.ok);
  });

  it('should reject invalid single tool call', () => {
    const toolCall: ParsedToolCall = { id: 'bad', name: '', arguments: {} };
    const result = validateSingleToolCall(toolCall);
    assert.ok(!result.ok);
  });
});

describe('detectToolCallLoop', () => {
  it('should pass on first call with no history', () => {
    const tc: ParsedToolCall = { id: 't1', name: 'read_file', arguments: { path: '/tmp/x' } };
    const result = detectToolCallLoop(tc, []);
    assert.ok(result.ok);
  });

  it('should pass with few repeats', () => {
    const tc: ParsedToolCall = { id: 't1', name: 'read_file', arguments: { path: '/tmp/x' } };
    const history = [
      { name: 'read_file', args: { path: '/tmp/a' } },
      { name: 'read_file', args: { path: '/tmp/b' } },
    ];
    const result = detectToolCallLoop(tc, history);
    assert.ok(result.ok);
  });

  it('should detect loop after maxRepeats identical calls', () => {
    const tc: ParsedToolCall = { id: 't5', name: 'read_file', arguments: { path: '/tmp/x' } };
    const history = [
      { name: 'read_file', args: { path: '/tmp/x' } },
      { name: 'read_file', args: { path: '/tmp/x' } },
      { name: 'read_file', args: { path: '/tmp/x' } },
      { name: 'read_file', args: { path: '/tmp/x' } },
    ];
    const result = detectToolCallLoop(tc, history, 4);
    assert.ok(!result.ok);
    assert.ok(result.errors[0].includes('Loop'));
  });

  it('should accept different args for same tool', () => {
    const tc: ParsedToolCall = { id: 't1', name: 'read_file', arguments: { path: '/tmp/different' } };
    const history = [
      { name: 'read_file', args: { path: '/tmp/x' } },
      { name: 'read_file', args: { path: '/tmp/x' } },
    ];
    const result = detectToolCallLoop(tc, history, 2);
    assert.ok(result.ok);
  });
});

describe('detectParallelToolLoop', () => {
  it('should pass with single tool call', () => {
    const tcs: ParsedToolCall[] = [
      { id: 't1', name: 'read_file', arguments: { path: '/tmp/x' } },
    ];
    const result = detectParallelToolLoop(tcs);
    assert.ok(result.ok);
  });

  it('should pass with different tool calls', () => {
    const tcs: ParsedToolCall[] = [
      { id: 't1', name: 'read_file', arguments: { path: '/tmp/x' } },
      { id: 't2', name: 'bash', arguments: { command: 'ls' } },
    ];
    const result = detectParallelToolLoop(tcs);
    assert.ok(result.ok);
  });

  it('should detect parallel loop with 3+ identical calls', () => {
    const tcs: ParsedToolCall[] = [
      { id: 't1', name: 'get_weather', arguments: { location: 'NYC' } },
      { id: 't2', name: 'get_weather', arguments: { location: 'NYC' } },
      { id: 't3', name: 'get_weather', arguments: { location: 'NYC' } },
    ];
    const result = detectParallelToolLoop(tcs);
    assert.ok(!result.ok);
    assert.ok(result.errors[0].includes('Parallel loop'));
  });

  it('should pass with 2 identical calls (not enough for loop detection)', () => {
    const tcs: ParsedToolCall[] = [
      { id: 't1', name: 'get_weather', arguments: { location: 'NYC' } },
      { id: 't2', name: 'get_weather', arguments: { location: 'NYC' } },
    ];
    const result = detectParallelToolLoop(tcs);
    assert.ok(result.ok);
  });
});