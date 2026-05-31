/*
 * File: ToolResultEchoFilter.test.ts
 * Tests for the shingle-based Jaccard echo filter.
 * Uses node:test runner (tsx --test).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ToolResultEchoFilter } from './ToolResultEchoFilter.ts';

describe('ToolResultEchoFilter', () => {
  describe('constructor', () => {
    it('should accept empty tool results array', () => {
      const filter = new ToolResultEchoFilter([]);
      assert.ok(filter !== undefined);
    });

    it('should accept multiple tool results', () => {
      const filter = new ToolResultEchoFilter([
        'Line 1\nLine 2\nLine 3',
        'Another result\nWith multiple lines',
      ]);
      assert.ok(filter !== undefined);
    });
  });

  describe('isEcho', () => {
    it('should return false for completely original content', () => {
      const filter = new ToolResultEchoFilter(['Tool result content here']);
      assert.equal(filter.isEcho('This is completely different content'), false);
    });

    it('should return true for verbatim echo of tool result line', () => {
      const toolResult = 'function hello() {\n  console.log("world");\n}';
      const filter = new ToolResultEchoFilter([toolResult]);
      assert.equal(filter.isEcho('function hello() {'), true);
    });

    it('should return true for near-duplicate with minor whitespace changes', () => {
      const toolResult = 'const x = 42;\nconst y = 100;';
      const filter = new ToolResultEchoFilter([toolResult]);
      // Extra spaces should still match (normalized)
      assert.equal(filter.isEcho('const  x  =  42;'), true);
    });

    it('should return true for paraphrased echo with high similarity', () => {
      const toolResult = 'The file contains 42 lines of code.';
      const filter = new ToolResultEchoFilter([toolResult]);
      // Shingles should catch this as similar (shared substrings)
      assert.equal(filter.isEcho('The file contains 42 lines of code'), true);
    });

    it('should return false for brief reference to tool result', () => {
      const toolResult = 'Error: File not found at /path/to/file.txt\nStack trace:\n  at line 42\n  at line 100';
      const filter = new ToolResultEchoFilter([toolResult]);
      // Brief mention should pass through
      assert.equal(filter.isEcho('The tool reported an error.'), false);
    });

    it('should return false for analysis/synthesis of tool result', () => {
      const toolResult = 'CPU: 45%\nMemory: 2.1GB\nDisk: 78%';
      const filter = new ToolResultEchoFilter([toolResult]);
      // Original analysis should pass
      assert.equal(filter.isEcho('System resources are within normal limits.'), false);
    });

    it('should handle empty lines gracefully', () => {
      const filter = new ToolResultEchoFilter(['Line 1\n\nLine 3']);
      assert.equal(filter.isEcho(''), false);
    });

    it('should skip very short lines (< 10 chars after normalization)', () => {
      const filter = new ToolResultEchoFilter(['const x = 42;']);
      // Short line should not match
      assert.equal(filter.isEcho('const x'), false);
    });
  });

  describe('filterText', () => {
    it('should remove echoed lines from multi-line text', () => {
      const toolResult = 'Line 1: Hello\nLine 2: World\nLine 3: Test';
      const filter = new ToolResultEchoFilter([toolResult]);
      const input = 'Line 1: Hello\nThis is original\nLine 2: World\nMore original content';
      const result = filter.filterText(input);
      assert.ok(!result.includes('Line 1: Hello'));
      assert.ok(!result.includes('Line 2: World'));
      assert.ok(result.includes('This is original'));
      assert.ok(result.includes('More original content'));
    });

    it('should preserve text when no echoes detected', () => {
      const toolResult = 'Tool output here';
      const filter = new ToolResultEchoFilter([toolResult]);
      const input = 'Completely different content\nWith multiple lines\nAll original';
      const result = filter.filterText(input);
      assert.equal(result, input);
    });

    it('should handle text with no line breaks', () => {
      const toolResult = 'Single line tool result';
      const filter = new ToolResultEchoFilter([toolResult]);
      const input = 'Single line original text';
      const result = filter.filterText(input);
      assert.equal(result, input);
    });

    it('should clean up multiple consecutive blank lines after filtering', () => {
      const toolResult = 'Echo line 1\nEcho line 2\nEcho line 3';
      const filter = new ToolResultEchoFilter([toolResult]);
      const input = 'Original\nEcho line 1\nEcho line 2\nEcho line 3\nMore original';
      const result = filter.filterText(input);
      // Should not have 3+ consecutive blank lines
      assert.ok(!/\n\n\n/.test(result));
    });
  });

  describe('ring buffer behavior', () => {
    it('should maintain bounded memory with many tool result lines', () => {
      // Create 200 lines of tool results
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`);
      const toolResult = lines.join('\n');
      const filter = new ToolResultEchoFilter([toolResult]);

      // Should not throw or consume excessive memory
      assert.equal(filter.isEcho('Some new content'), false);
    });

    it('should evict old entries when buffer is full', () => {
      const toolResult = Array.from({ length: 150 }, (_, i) => `Line ${i}: content`).join('\n');
      const filter = new ToolResultEchoFilter([toolResult]);

      // Ring buffer = 100, 150 lines → first 50 evicted, lines 50-149 retained
      assert.equal(filter.isEcho('Line 0: content'), false);  // evicted
      assert.equal(filter.isEcho('Line 50: content'), true);   // still in buffer
      assert.equal(filter.isEcho('Line 149: content'), true);  // last line
    });
  });

  describe('edge cases', () => {
    it('should handle tool results with only whitespace', () => {
      const filter = new ToolResultEchoFilter(['   \n  \n   ']);
      assert.equal(filter.isEcho('Some content'), false);
    });

    it('should handle tool results with special characters', () => {
      const toolResult = 'Error: \\n\\t at line 42\\nStack: \\"file.ts\\"';
      const filter = new ToolResultEchoFilter([toolResult]);
      assert.equal(filter.isEcho('Error: \\n\\t at line 42'), true);
    });

    it('should handle very long lines', () => {
      const longLine = 'x'.repeat(10000);
      const filter = new ToolResultEchoFilter([longLine]);
      assert.equal(filter.isEcho(longLine), true);
      assert.equal(filter.isEcho('y'.repeat(10000)), false);
    });

    it('should handle Unicode content', () => {
      const toolResult = 'Error: 文件未找到\n位置: /路径/到/文件.txt';
      const filter = new ToolResultEchoFilter([toolResult]);
      assert.equal(filter.isEcho('Error: 文件未找到'), true);
    });
  });

  describe('shingle algorithm', () => {
    it('should compute consistent shingle sets for identical input', () => {
      const filter = new ToolResultEchoFilter([]);
      const shingles1 = (filter as any).computeShingles('the quick brown fox');
      const shingles2 = (filter as any).computeShingles('the quick brown fox');
      assert.deepStrictEqual(shingles1, shingles2);
    });

    it('should produce overlapping shingle sets for similar input', () => {
      const filter = new ToolResultEchoFilter([]);
      const shingles1 = (filter as any).computeShingles('the quick brown fox');
      const shingles2 = (filter as any).computeShingles('the quick brown fox jumps');
      const sim = (filter as any).jaccardSimilarity(shingles1, shingles2);
      assert.ok(sim >= 0.7);
    });

    it('should produce disjoint shingle sets for different input', () => {
      const filter = new ToolResultEchoFilter([]);
      const shingles1 = (filter as any).computeShingles('completely different');
      const shingles2 = (filter as any).computeShingles('entirely unrelated');
      const sim = (filter as any).jaccardSimilarity(shingles1, shingles2);
      assert.ok(sim < 0.3);
    });
  });

  describe('getEchoRatio', () => {
    it('should return 0.0 for text with no echoes', () => {
      const filter = new ToolResultEchoFilter(['Tool result line']);
      assert.equal(filter.getEchoRatio('Completely original content'), 0.0);
    });

    it('should return 1.0 for text that is entirely echoes', () => {
      const filter = new ToolResultEchoFilter(['Tool result line']);
      assert.equal(filter.getEchoRatio('Tool result line'), 1.0);
    });

    it('should return correct ratio for mixed content', () => {
      const filter = new ToolResultEchoFilter(['tool result line here']);
      // One echo out of 4 non-empty lines (each >= 10 chars)
      const ratio = filter.getEchoRatio('tool result line here\noriginal content a\noriginal content b\noriginal content c');
      assert.equal(ratio, 0.25);
    });

    it('should return 0.0 for empty text', () => {
      const filter = new ToolResultEchoFilter(['some result']);
      assert.equal(filter.getEchoRatio(''), 0.0);
    });
  });

  describe('Jaccard similarity', () => {
    it('should return 1.0 for identical token sets', () => {
      const filter = new ToolResultEchoFilter([]);
      const tokens1 = new Set(['a', 'b', 'c']);
      const tokens2 = new Set(['a', 'b', 'c']);
      const similarity = (filter as any).jaccardSimilarity(tokens1, tokens2);
      assert.equal(similarity, 1.0);
    });

    it('should return 0.0 for disjoint token sets', () => {
      const filter = new ToolResultEchoFilter([]);
      const tokens1 = new Set(['a', 'b', 'c']);
      const tokens2 = new Set(['x', 'y', 'z']);
      const similarity = (filter as any).jaccardSimilarity(tokens1, tokens2);
      assert.equal(similarity, 0.0);
    });

    it('should return correct value for partial overlap', () => {
      const filter = new ToolResultEchoFilter([]);
      const tokens1 = new Set(['a', 'b', 'c', 'd']);
      const tokens2 = new Set(['c', 'd', 'e', 'f']);
      const similarity = (filter as any).jaccardSimilarity(tokens1, tokens2);
      // Intersection: {c, d} = 2, Union: {a,b,c,d,e,f} = 6
      assert.ok(Math.abs(similarity - (2 / 6)) < 0.01);
    });
  });
});
