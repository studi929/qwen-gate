import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { StreamingToolParser } from './parser.ts';

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

function xmlFunc(name: string, params: Record<string, string>): string {
  const inner = Object.entries(params)
    .map(([k, v]) => `<parameter=${k}>${v}</parameter>`)
    .join('\n');
  return `<function=${name}>\n${inner}\n</function>`;
}

describe('StreamingToolParser - Qwen XML format', () => {
  it('S1: extracts <function=name> tool call from text', () => {
    const parser = new StreamingToolParser();
    const input = `Let me check.\n${xmlFunc('bash', { command: 'ls -la' })}\nDone.`;
    const result = parser.feed(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'bash');
    assert.equal((result.toolCalls[0].arguments as any).command, 'ls -la');
    assert.ok(result.text.includes('Let me check'));
    assert.ok(result.text.includes('Done'));
  });

  it('S2: strips Qwen Core- prefix from tool name', () => {
    const parser = new StreamingToolParser();
    const input = xmlFunc('Qwen Core-bash', { command: 'echo hi' });
    const result = parser.feed(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'bash');
  });

  it('S3: multiple <function=name> tool calls in sequence', () => {
    const parser = new StreamingToolParser();
    const input = `${xmlFunc('read', { filePath: '/tmp/a' })}\n${xmlFunc('grep', { pattern: 'foo', path: '/tmp' })}`;
    const result = parser.feed(input);
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.toolCalls[0].name, 'read');
    assert.equal(result.toolCalls[1].name, 'grep');
  });

  it('S4: streaming chunks split mid-<function= tag buffer and complete', () => {
    const parser = new StreamingToolParser();
    const chunks = [
      'Some text <fun',
      'ction=bash>\n<parameter=command>ls</parameter>\n</function> end',
    ];
    const allCalls: any[] = [];
    for (const ch of chunks) {
      const r = parser.feed(ch);
      allCalls.push(...r.toolCalls);
    }
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'bash');
  });

  it('S5: streaming split inside parameter value', () => {
    const parser = new StreamingToolParser();
    const chunks = [
      '<function=bash>\n<parameter=command>echo "hel',
      'lo world"</parameter>\n</function>',
    ];
    const allCalls: any[] = [];
    for (const ch of chunks) {
      const r = parser.feed(ch);
      allCalls.push(...r.toolCalls);
    }
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].arguments.command, 'echo "hello world"');
  });

  it('S6: buffered incomplete <function= tag at end waits for more data', () => {
    const parser = new StreamingToolParser();
    const r1 = parser.feed('Before <function=bash>\n<parameter=command>ls</para');
    assert.equal(r1.toolCalls.length, 0);
    assert.ok(r1.text.includes('Before'));
    const r2 = parser.feed('meter>\n</function> After');
    assert.equal(r2.toolCalls.length, 1);
    assert.equal(r2.toolCalls[0].name, 'bash');
    assert.ok(r2.text.includes('After'));
  });

  it('S7: text without tool calls is emitted via feed', () => {
    const parser = new StreamingToolParser();
    const r = parser.feed('Hello world');
    assert.equal(r.toolCalls.length, 0);
    assert.ok(r.text.includes('Hello world'));
  });

  it('S8: emitted tool call count survives flush', () => {
    const parser = new StreamingToolParser();
    parser.feed(xmlFunc('read', { filePath: '/tmp/x' }));
    parser.feed(xmlFunc('bash', { command: 'ls' }));
    assert.equal(parser.getEmittedToolCallCount(), 2);
    parser.flush();
    assert.equal(parser.getEmittedToolCallCount(), 2);
  });

  it('S9: unknown tool name not in known list is still extracted from <function=>', () => {
    const parser = new StreamingToolParser();
    const input = xmlFunc('custom_tool', { param1: 'val1' });
    const result = parser.feed(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'custom_tool');
  });
});

describe('StreamingToolParser - function_calls XML format', () => {
  it('S10: <function_calls> block with <invoke> is extracted', () => {
    const parser = new StreamingToolParser();
    const input = '<function_calls>\n<invoke name="bash">\n<parameter name="command">date</parameter>\n</invoke>\n</function_calls>';
    const result = parser.feed(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'bash');
  });

  it('S11: <function_calls> buffered across stream chunks', () => {
    const parser = new StreamingToolParser();
    const chunks = ['<function_', 'calls>\n<invoke name="bash">\n', '<parameter name="command">date</parameter>\n', '</invoke>\n</function_calls>'];
    const allCalls: any[] = [];
    for (const ch of chunks) {
      const r = parser.feed(ch);
      allCalls.push(...r.toolCalls);
    }
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0].name, 'bash');
  });
});

describe('StreamingToolParser - single XML tag format', () => {
  it('S12: <ToolRead> maps to read tool', () => {
    const parser = new StreamingToolParser();
    const input = '<ToolRead>\n<parameter name="filePath">/tmp/x</parameter>\n</ToolRead>';
    const result = parser.feed(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read');
  });

  it('S13: lowercase <bash> with <param> tag', () => {
    const parser = new StreamingToolParser();
    const input = '<bash><param name="command">echo hi</param></bash>';
    const result = parser.feed(input);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'bash');
  });
});

describe('StreamingToolParser passThrough mode', () => {
  it('S14: passThrough=true returns raw text', () => {
    const parser = new StreamingToolParser();
    parser.passThrough = true;
    const input = xmlFunc('bash', { command: 'ls' });
    const result = parser.feed(input);
    assert.equal(result.toolCalls.length, 0);
    assert.ok(result.text.includes('<function='));
  });
});
