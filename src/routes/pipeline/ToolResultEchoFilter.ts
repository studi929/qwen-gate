/*
 * File: ToolResultEchoFilter.ts
 * Character n-gram (shingle) Jaccard filter for detecting tool result echoes in LLM output.
 *
 * Algorithm:
 * - Character 5-grams (shingles) for robust near-duplicate detection
 * - Jaccard similarity on shingle sets, threshold 0.7
 * - Ring buffer: 100 lines max to bound memory
 *
 * Character shingles are more reliable than SimHash + word tokens for
 * short text lines because they capture substring overlap directly and
 * don't depend on hash locality properties.
 *
 * Usage:
 *   const filter = new ToolResultEchoFilter(toolResultContents);
 *   const isEcho = filter.isEcho(line);
 *   const cleanText = filter.filterText(fullText);
 */

const SHINGLE_SIZE = 5;
const JACCARD_THRESHOLD = 0.7;
const RING_BUFFER_SIZE = 100;
const MIN_LINE_LENGTH = 10;

export class ToolResultEchoFilter {
  private fingerprints: Set<string>[] = [];

  constructor(toolResults: string[]) {
    for (const result of toolResults) {
      const lines = result.split('\n');
      for (const line of lines) {
        const normalized = this.normalizeLine(line);
        if (normalized.length < MIN_LINE_LENGTH) continue;

        const shingles = this.computeShingles(normalized);
        this.fingerprints.push(shingles);

        // Ring buffer eviction
        if (this.fingerprints.length > RING_BUFFER_SIZE) {
          this.fingerprints.shift();
        }
      }
    }
  }

  /**
   * Check if a single line is an echo of tool result content.
   */
  isEcho(line: string): boolean {
    const normalized = this.normalizeLine(line);
    if (normalized.length < MIN_LINE_LENGTH) return false;

    const shingles = this.computeShingles(normalized);

    for (const fp of this.fingerprints) {
      const containment = this.shingleContainment(shingles, fp);
      if (containment >= JACCARD_THRESHOLD) return true;
    }

    return false;
  }

  /**
   * Return the fraction of lines that are echoes (0.0 to 1.0).
   * Used to detect heavy echo activity that warrants correction prompts.
   */
  getEchoRatio(text: string): number {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return 0.0;
    let echoCount = 0;
    for (const line of lines) {
      if (this.isEcho(line)) echoCount++;
    }
    return echoCount / lines.length;
  }

  /**
   * Filter echoed lines from multi-line text.
   */
  filterText(text: string): string {
    const lines = text.split('\n');
    const filtered = lines.filter(line => !this.isEcho(line));

    const cleaned: string[] = [];
    let prevBlank = false;
    for (const line of filtered) {
      const isBlank = line.trim() === '';
      if (isBlank && prevBlank) continue;
      cleaned.push(line);
      prevBlank = isBlank;
    }

    return cleaned.join('\n');
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
      // For very short text (>= MIN_LINE_LENGTH but < SHINGLE_SIZE),
      // use the whole text as a single shingle
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
   *
   * This is preferred over symmetric Jaccard for echo detection because
   * the query (echo line) is often shorter than the reference (tool result
   * line). Containment correctly handles substring overlap regardless of
   * relative lengths.
   */
  private shingleContainment(query: Set<string>, fingerprint: Set<string>): number {
    if (query.size === 0) return 0.0;

    let intersection = 0;
    for (const shingle of query) {
      if (fingerprint.has(shingle)) intersection++;
    }

    return intersection / query.size;
  }

  /**
   * Compute Jaccard similarity between two shingle sets.
   * Returns value between 0 (disjoint) and 1 (identical).
   */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1.0;
    if (a.size === 0 || b.size === 0) return 0.0;

    let intersection = 0;
    for (const shingle of a) {
      if (b.has(shingle)) intersection++;
    }

    const union = a.size + b.size - intersection;
    return intersection / union;
  }
}
