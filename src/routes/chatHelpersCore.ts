
import { validateSingleToolCall } from "../tools/guard.ts";
import { logStore } from "../services/logStore.ts";

export function safeTruncate(val: any, maxLen = 200): any {
  if (typeof val === "string") {
    if (val.length > maxLen) return val.substring(0, maxLen) + "...";
    return val;
  }
  if (Array.isArray(val)) return val.map((v) => safeTruncate(v, maxLen));
  if (val && typeof val === "object") {
    const obj: any = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = safeTruncate(v, maxLen);
    }
    return obj;
  }
  return val;
}

// ── String / diff utilities ───────────────────────────────────────

export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

export function getNewContent(text: string, lastEmittedText: string): string {
  if (!text) return "";
  const commonLen = commonPrefixLen(text, lastEmittedText);
  if (commonLen < text.length) return text.substring(commonLen);
  return "";
}

export function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

export function detectCumulativeChunk(
  newText: string,
  lastText: string,
): { cumulative: boolean; delta: string } {
  if (!lastText || !newText) return { cumulative: false, delta: newText };
  if (newText === lastText) return { cumulative: false, delta: "" };

  // Fast path: exact prefix match
  if (newText.startsWith(lastText) && newText.length > lastText.length) {
    return { cumulative: true, delta: newText.substring(lastText.length) };
  }

  // Fingerprint-based recovery: Qwen sometimes resends cumulative content
  // with minor edits (extra words, rephrasing). Use suffix fingerprints to
  // find where old content resumes in the new text.
  if (newText.length > lastText.length && lastText.length >= 32) {
    // Try multiple fingerprint sizes for robustness
    for (const fpSize of [64, 48, 32, 24]) {
      if (lastText.length < fpSize) continue;
      const fingerprint = lastText.slice(-fpSize);
      const idx = newText.indexOf(fingerprint);
      if (idx === -1) continue;

      const expectedEnd = idx + lastText.length;
      if (expectedEnd > newText.length) continue;

      // Check if the found position is plausible: the overlap region at
      // expectedEnd should match the tail of lastText by at least 75%.
      const overlap = newText.substring(expectedEnd - Math.min(20, lastText.length), expectedEnd);
      const lastTail = lastText.slice(-overlap.length);
      const overlapMatch = commonSuffixLen(overlap, lastTail);
      if (overlapMatch < overlap.length * 0.75 && overlapMatch < 3) continue;

      const delta = newText.substring(expectedEnd);
      if (delta) {
        return { cumulative: true, delta };
      }
    }
  }

  return { cumulative: false, delta: newText };
}

export function getSnapshotDelta(
  newSnapshot: string,
  lastSnapshot: string,
): string {
  if (!newSnapshot) return "";
  if (!lastSnapshot) return newSnapshot;
  if (newSnapshot === lastSnapshot) return "";

  // Fast path: monotonic growth (the common case)
  if (newSnapshot.length > lastSnapshot.length && newSnapshot.startsWith(lastSnapshot))
    return newSnapshot.substring(lastSnapshot.length);

  // When cleaning removes characters (e.g. partial <tool_call completing to
  // <tool_call> which then gets stripped by cleanThinkTags), newSnapshot can
  // be SHORTER than lastSnapshot. Use common prefix to find what's genuinely new.
  // Also handles the case where previous content was re-cleaned more aggressively.
  const prefixLen = commonPrefixLen(newSnapshot, lastSnapshot);
  if (prefixLen > 0 && prefixLen < newSnapshot.length) {
    return newSnapshot.substring(prefixLen);
  }
  if (prefixLen === newSnapshot.length && prefixLen > 0) {
    // newSnapshot is entirely a prefix of lastSnapshot — nothing genuinely new
    return "";
  }

  // Fallback: fingerprint-based cumulative chunk detection for overlapping content
  const detection = detectCumulativeChunk(newSnapshot, lastSnapshot);
  if (detection.cumulative) return detection.delta;
  return "";
}

/** Matches closing/opening think tags (with optional attributes/self-close). */
const THINK_TAG_PATTERN = /<\/?(?:think(?:ing)?|thought)(?:\s[^>]*)?\/?>/gi;
/** Matches tool result tag fragments (requires closing > to avoid false stripping of /toolbox /toolkit etc). */
const TOOL_RESULT_TAG_PATTERN = /<\/tool(?:_result)?>/gi;

export function cleanThinkTags(t: string): string {
  let s = t.replace(THINK_TAG_PATTERN, "");
  s = s.replace(TOOL_RESULT_TAG_PATTERN, "");
  // Strip any remaining <function=...> or </function> markup that may have
  // leaked from partial/incomplete tool call XML in Qwen's output
  s = s.replace(/<function=[^>]*(?:>|(?=\n|$))/g, '');
  s = s.replace(/<\/?function>/g, '');
  return s;
}

export { truncateToolResult, compressToolResult } from "./compressToolResult.ts";

// ── Tool and streaming utilities ──────────────────────────────────

export class ToolSpamGuard {
  private window: number;
  private threshold: number;
  private history: Array<{ key: string }>;

  constructor(window = 8, threshold = 2) {
    this.window = window;
    this.threshold = threshold;
    this.history = [];
  }

  private canonicalize(args: any): any {
    if (typeof args !== "object" || args === null) return args;
    if (Array.isArray(args)) return args.map((a) => this.canonicalize(a));
    return Object.keys(args).sort().reduce((acc: any, key) => {
      acc[key] = this.canonicalize(args[key]);
      return acc;
    }, {});
  }

  check(tool: string, args: any): { ok: true } | { ok: false; correctionPrompt: string } {
    const key = `${tool}:${JSON.stringify(this.canonicalize(args))}`;
    const recent = this.history.slice(-this.window);
    const count = recent.filter((h) => h.key === key).length + 1;
    this.history.push({ key });
    if (count > this.threshold) {
      return {
        ok: false,
        correctionPrompt:
          `[TOOL SPAM] Called "${tool}" with identical arguments ${count} times in the last ${this.window} calls. ` +
          `Stop repeating this call. Analyze the results you already have and respond to the user. ` +
          `Do NOT call "${tool}" again with the same arguments.`,
      };
    }
    return { ok: true };
  }
}

export const pendingCorrections = new Map<string, string[]>();

// Prevent unbounded growth: trim oldest entries every 5 minutes
const MAX_PENDING_CORRECTIONS = 500;
setInterval(() => {
  if (pendingCorrections.size > MAX_PENDING_CORRECTIONS) {
    const toDelete = pendingCorrections.size - MAX_PENDING_CORRECTIONS;
    let i = 0;
    for (const key of pendingCorrections.keys()) {
      if (i >= toDelete) break;
      pendingCorrections.delete(key);
      i++;
    }
  }
}, 5 * 60 * 1000).unref();

export function parseQwenErrorPayload(
  raw: string,
): { message: string; status: import("hono/utils/http-status").ContentfulStatusCode } | null {
  const text = raw.trim();
  if (!text || text.startsWith("data: ")) return null;
  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || "UpstreamError";
      const details = payload.data?.details || payload.message || "Qwen returned an error";
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : "";
      const status = code === "RateLimited" ? 429 : code === "Not_Found" ? 404 : 502;
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === "string" ? payload.error : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
  } catch {
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }
  return null;
}

export interface DeltaContentResult {
  vStr: string;
  foundStr: boolean;
  isThinkingChunk: boolean;
  currentThoughtIndex: number;
}

export function extractDeltaContent(
  chunk: any,
  targetResponseId: string | null,
  currentThoughtIndex: number,
  reasoningBuffer: string,
): DeltaContentResult {
  let vStr = "";
  let foundStr = false;
  let isThinkingChunk = false;
  let newThoughtIndex = currentThoughtIndex;

  if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && (targetResponseId === null || chunk.response_id === targetResponseId)) {
    const delta = chunk.choices[0].delta;
    if (delta.phase === "thinking_summary") {
      isThinkingChunk = true;
      if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
        const thoughts = delta.extra.summary_thought.content;
        const rawNew = thoughts.slice(currentThoughtIndex).join("\n");
        if (rawNew) {
          const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
          vStr = rawNew.substring(commonLen);
          if (vStr) { newThoughtIndex = thoughts.length; foundStr = true; }
        }
      }
    } else if (delta.phase === "think") {
      isThinkingChunk = true;
      if (delta.content !== undefined) {
        vStr = delta.content || "";
        if (vStr) foundStr = true;
      }
    } else if (delta.phase === "answer") {
      isThinkingChunk = false;
      if (delta.content !== undefined) {
        vStr = delta.content || "";
        if (vStr) foundStr = true;
      }
    }
  }
  return { vStr, foundStr, isThinkingChunk, currentThoughtIndex: newThoughtIndex };
}

export interface ToolCallProcessingOptions {
  label?: string;
  logParsed?: boolean;
  logId: string;
  toolSpamGuard: ToolSpamGuard;
  correctionPrompts: string[];
  maxToolCalls: number;
}

const MAX_TOOL_CALLS_PER_TURN = 8;

export function processToolCallsThroughGuard(
  toolCalls: any[],
  toolCallsOut: any[],
  options: ToolCallProcessingOptions,
): void {
  const { label, logParsed = false, logId, toolSpamGuard, correctionPrompts, maxToolCalls } = options;

  if (toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
    console.warn(`  [🛑 TOOL LIMIT${label ? " " + label : ""}] Truncating ${toolCalls.length} tool calls to first ${MAX_TOOL_CALLS_PER_TURN}`);
    toolCalls = toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
  }

  for (const tc of toolCalls) {
    const guard = validateSingleToolCall(tc);
    if (!guard.ok) {
      correctionPrompts.push(guard.correctionPrompt);
      continue;
    }
    const spamCheck = toolSpamGuard.check(tc.name, tc.arguments);
    if (!spamCheck.ok) {
      console.warn(`  [🛑 TOOL SPAM${label ? " " + label : ""}] ${tc.name}: repeated call blocked`);
      correctionPrompts.push(spamCheck.correctionPrompt);
      continue;
    }
    if (toolCallsOut.length >= maxToolCalls) {
      console.warn(`  [🛑 TOOL LIMIT${label ? " " + label : ""}] Hit ${maxToolCalls} tool calls per turn, dropping excess`);
      correctionPrompts.push(`[TOOL CALL LIMIT] Reached maximum of ${maxToolCalls} tool calls per turn. Analyze existing results and respond to the user.`);
      break;
    }
    toolCallsOut.push({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    });
    if (logParsed) {
      logStore.updateEntry(logId, (entry: any) => {
        entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
      });
    }
  }
}

export interface AmplificationGuardState {
  rawInputBytes: number;
  emittedOutputBytes: number;
  triggered: boolean;
}

export function checkAmplificationGuard(
  state: AmplificationGuardState,
  newOutputLen: number,
  logId: string,
  resolvedEmail: string,
  model: string,
  lastRawContent: string,
  lastVStrRaw: string,
): boolean {
  if (!state.triggered) {
    const projectedRatio = (state.emittedOutputBytes + newOutputLen) / Math.max(1, state.rawInputBytes);
    if (projectedRatio > 3 && state.emittedOutputBytes > 1000) {
      state.triggered = true;
      const ratio = Math.round(projectedRatio * 100) / 100;
      console.error(
        `[Chat][AMPLIFICATION GUARD] Triggered! ratio=${ratio}x rawIn=${state.rawInputBytes}B emittedOut=${state.emittedOutputBytes}B account=${resolvedEmail} model=${model}`,
      );
      logStore.recordAmplificationEvent(logId, ratio, lastRawContent || lastVStrRaw || "");
    }
  }
  return state.triggered;
}
