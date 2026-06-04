/*
 * File: StreamingEchoFilter.ts
 * Streaming-native echo detection with hold-back buffer.
 *
 * Unlike ToolResultEchoFilter which processes the full accumulated text per chunk,
 * this filter checks only NEW complete lines at line boundaries. Content is held
 * in a buffer until a complete line (ending with \n) is received, then checked
 * against tool result fingerprints. If any line matches >= 70% similarity, the
 * stream is aborted BEFORE that line is emitted to the client.
 *
 * Algorithm:
 * - Character 5-gram (shingle) containment for robust near-duplicate detection
 * - Hold-back buffer: content held until line boundary confirmed clean
 * - O(1) amortized per chunk (only checks new complete lines, not full text)
 *
 * Usage:
 *   const filter = new StreamingEchoFilter(toolResultContents);
 *   for each chunk:
 *     const result = filter.feed(fullAccumulatedText);
 *     if (result.echoDetected) { abort upstream; break; }
 *     emit(result.cleanDelta);  // only confirmed-clean content
 *   const remaining = filter.flush(lastFullText);  // emit held trailing content
 */

import { config } from '../../services/configService.ts';

const SHINGLE_SIZE = 5;
const JACCARD_THRESHOLD = parseFloat(config.get('ECHO_JACCARD_THRESHOLD', '0.9'));
const MIN_LINE_LENGTH = parseInt(config.get('ECHO_MIN_LINE_LENGTH', '20'), 10);
const MIN_UNIQUE_SHINGLES = parseInt(config.get('ECHO_MIN_UNIQUE_SHINGLES', '8'), 10);
const CANARY_PATTERN = /\[tc-[0-9a-f]{8}\]/;

export interface StreamingEchoResult {
  cleanDelta: string;
  echoDetected: boolean;
  similarity: number;
  reason: string;
  /** The exact output line that triggered the echo detection */
  matchedLine: string;
}

export class StreamingEchoFilter {
  private fingerprints: Set<string>[] = [];
  private confirmedLength: number = 0;

    constructor(toolResults: string[]) {
    for (const result of toolResults) {
      const lines = result.split('\n');
      for (const line of lines) {
        const normalized = this.normalizeLine(line);
        if (normalized.length < MIN_LINE_LENGTH) continue;
        const shingles = this.computeShingles(normalized);
        if (shingles.size < MIN_UNIQUE_SHINGLES) continue;
        this.fingerprints.push(shingles);
      }
    }
  }

  /**
   * Feed the full accumulated text. Returns deltas of new confirmed-clean content.
   * Only checks NEW complete lines (ending with \n) against fingerprints.
   *
   * Content is held in a buffer until a line boundary is confirmed clean.
   * This prevents echo content from leaking to the client before abort.
   *
   * @param fullText - The full accumulated text from the streaming parser
   * @returns StreamingEchoResult with cleanDelta, echoDetected, similarity, reason
   */
  feed(fullText: string): StreamingEchoResult {
    // 1. No new content
    if (fullText.length <= this.confirmedLength) {
      return { cleanDelta: '', echoDetected: false, similarity: 0, reason: '', matchedLine: '' };
    }

    // 2. Extract new content beyond confirmed position
    const newContent = fullText.substring(this.confirmedLength);

    // 3. Find last newline — everything before it is a complete line
    const lastNewline = newContent.lastIndexOf('\n');
    if (lastNewline < 0) {
      // No complete line yet — hold everything
      return { cleanDelta: '', echoDetected: false, similarity: 0, reason: '', matchedLine: '' };
    }

    // 4. Split complete lines
    const completeLines = newContent.substring(0, lastNewline + 1);
    const lines = completeLines.split('\n').filter(l => l.length > 0);

    // 5. Check each line against fingerprints
    let maxSimilarity = 0;
    let matchedLine = '';
    for (const line of lines) {
      // Zero-false-positive canary token check — runs before shingle containment
      if (CANARY_PATTERN.test(line)) {
        return {
          cleanDelta: '',
          echoDetected: true,
          similarity: 1.0,
          reason: `Echo detected (canary token match)`,
          matchedLine: line,
        };
      }
      const normalized = this.normalizeLine(line);
      if (normalized.length < MIN_LINE_LENGTH) continue;

      const shingles = this.computeShingles(normalized);
      if (shingles.size < MIN_UNIQUE_SHINGLES) continue;
      for (const fp of this.fingerprints) {
        // Bidirectional containment: output→tool AND tool→output
        // This prevents false positives when short output lines happen to share shingles
        // with long tool result lines (common with natural language)
        const outputToTool = this.shingleContainment(shingles, fp);
        const toolToOutput = this.shingleContainment(fp, shingles);
        const containment = Math.min(outputToTool, toolToOutput);

        if (containment > maxSimilarity) {
          maxSimilarity = containment;
          matchedLine = line;
        }
        if (containment >= JACCARD_THRESHOLD) {
          return {
            cleanDelta: '',
            echoDetected: true,
            similarity: containment,
            reason: `Echo detected (${(containment * 100).toFixed(1)}% similarity)`,
            matchedLine,
          };
        }
      }
    }

    // 6. All complete lines are clean — advance confirmed position
    this.confirmedLength += lastNewline + 1;

    return {
      cleanDelta: completeLines,
      echoDetected: false,
      similarity: maxSimilarity,
      reason: '',
      matchedLine: '',
    };
  }

  /**
   * Flush any remaining held content. Call once when streaming is complete.
   * At stream end, no more data is coming, so trailing text can't be a partial echo.
   *
   * @param fullText - The final full accumulated text
   * @returns Any remaining content that was held back
   */
  flush(fullText: string): string {
    if (fullText.length > this.confirmedLength) {
      const remaining = fullText.substring(this.confirmedLength);
      this.confirmedLength = fullText.length;
      return remaining;
    }
    this.confirmedLength = 0;
    return '';
  }

  /**
   * Reset the filter state (e.g., for reuse across requests).
   */
  reset(): void {
    this.confirmedLength = 0;
    this.fingerprints = [];
  }

  /**
   * Normalize a line for comparison: lowercase, collapse whitespace, trim.
   */
  private normalizeLine(line: string): string {
    return line.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * Compute character n-gram (shingle) set from normalized text.
   * Shingles capture substring overlap, making them robust for
   * near-duplicate detection of short text lines.
   */
  private computeShingles(text: string): Set<string> {
    const shingles = new Set<string>();
    if (text.length < SHINGLE_SIZE) {
      shingles.add(text);
      return shingles;
    }
    for (let i = 0; i <= text.length - SHINGLE_SIZE; i++) {
      shingles.add(text.substring(i, i + SHINGLE_SIZE));
    }
    return shingles;
  }

  /**
   * Compute containment of query shingle set within fingerprint set.
   * Returns |query ∩ fingerprint| / |query| — the fraction of the query
   * line's shingles that appear in the fingerprint.
   */
  private shingleContainment(query: Set<string>, fingerprint: Set<string>): number {
    if (query.size === 0) return 0.0;
    let intersection = 0;
    for (const shingle of query) {
      if (fingerprint.has(shingle)) intersection++;
    }
    return intersection / query.size;
  }
}
