/*
 * File: logStore.ts
 * In-memory log store — captures client requests and Qwen responses
 * for viewing at http://qwen-gate/log (SSE) and http://qwen-gate/log/json
 *
 * Also provides a system-level logger with levels, categories, filtering,
 * and optional file persistence for operational events (auth, circuit breaker,
 * session pool, streaming failures, etc.).
 */
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  recordModelError as _recordModelError,
  recordModelSuccess as _recordModelSuccess,
  getModelHealth as _getModelHealth,
  resetModelHealth as _resetModelHealth,
  getAllModelHealth as _getAllModelHealth,
} from "./modelHealth.ts";
import { config } from "./configService.ts";
export type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
export interface SystemLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}
export interface SystemLogFilter {
  minLevel?: LogLevel;
  category?: string;
  since?: string;
  limit?: number;
}
export interface LogEntry {
  id: string;
  timestamp: string;
  model: string;
  stream: boolean;
  accountEmail: string;
  level: LogLevel;
  request_id: string;
  latency_ms: number | null;
  tokens: { prompt: number; completion: number; total: number } | null;
  input?: string; // Sanitized prompt for display
  rawRequestBody?: Record<string, unknown> | string; // Full OpenAI request body
  rawResponse?: string; // Full raw response from Qwen (not truncated)
  processedResponse?: string; // After content filtering/tool parsing
  error?: string | null;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    success: boolean;
    blocked?: boolean;
    blockReason?: string;
    error?: string;
    executionTimeMs?: number;
  }>;
  networkTiming?: {
    dnsLookup: number;
    tcpConnect: number;
    tlsHandshake: number;
    firstByte: number;
    total: number;
  };
  // Dashboard fields
  clientRequest?: {
    messageCount: number;
    roles: string[];
    hasTools: boolean;
    toolNames: string[];
    tool_choice: unknown | null;
    lastMessage: string;
    messages: Array<{ role: string; content: string }>;
  };
  promptToQwen?: {
    systemPromptLength: number;
    totalLength: number;
    preview: string;
    /** Estimated tokens in client's original messages (pre-inflation) */
    clientTokens?: number;
    /** Estimated tokens from content injected by qwen-gate (system prompt, formatting, tool instructions) */
    overheadTokens?: number;
    /** Total estimated tokens sent to Qwen (clientTokens + overheadTokens) */
    estimatedTotalTokens?: number;
  };
  qwenRawChunks: string[];
  rawFullContent: string;
  toolCallResults?: unknown[];
  parsedToolCalls: Array<{ name: string; args: string }>;
  remainingText: string;
  processedApiOutput: string;
  finalResponse?: {
    finishReason: string;
    toolCallCount: number;
    contentPreview: string;
  };
  errors: string[];
  amplificationRatio?: number;
  amplificationTriggeredInput?: string;
}
const MAX_ENTRIES = parseInt(config.get("MAX_LOGS", "50"), 10);
const MAX_CHUNKS_PER_ENTRY = 100;
const MAX_SYSTEM_ENTRIES = 200;
const MAX_FIELD_LENGTH = 10240;
class LogStore {
  private entries: LogEntry[] = [];
  private entryMap: Map<string, LogEntry> = new Map();
  private systemEntries: SystemLogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private systemListeners: Set<(entry: SystemLogEntry) => void> = new Set();
  private systemIdCounter = 0;
  private serverStartTime = Date.now();
  private requestLogDir: string | null = null;
  private requestDirMap: Map<string, string> = new Map();

  /**
   * Enable per-request file logging. Each request gets its own folder
   * under `dirPath/<timestamp>/` containing:
   *   input.json, raw_output.txt, processed_output.txt, chunk_stream.txt
   */
  enableRequestFileLogging(dirPath: string): void {
    try {
      mkdirSync(dirPath, { recursive: true });
      this.requestLogDir = dirPath;
    } catch {
      this.requestLogDir = null;
    }
  }

  getRequestLogDir(): string | null {
    return this.requestLogDir;
  }

  private ensureRequestDir(id: string): string | null {
    if (!this.requestLogDir) return null;
    let ts = this.requestDirMap.get(id);
    if (!ts) {
      const d = new Date();
      const y = d.getFullYear();
      const M = d.getMonth() + 1;
      const day = d.getDate();
      const h = d.getHours();
      const min = d.getMinutes();
      const s = d.getSeconds();
      ts = y + "-" + M + "-" + day + "_" + h + "-" + min + "-" + s;
      this.requestDirMap.set(id, ts);
    }
    const dir = join(this.requestLogDir, ts);
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return null;
    }
  }

  saveRequestInput(id: string, body: unknown): void {
    if (config.get("SAVE_REQUEST_LOGS") !== "true") return;
    const dir = this.ensureRequestDir(id);
    if (!dir) return;
    try {
      writeFileSync(join(dir, "input.json"), JSON.stringify(body, null, 2));
    } catch {
      /* disk write best-effort */
    }
  }

  log(
    level: LogLevel,
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const entry: SystemLogEntry = {
      id: `sys-${++this.systemIdCounter}`,
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata,
    };
    this.systemEntries.unshift(entry);
    if (this.systemEntries.length > MAX_SYSTEM_ENTRIES)
      this.systemEntries.pop();
    for (const listener of this.systemListeners) {
      try {
        listener(entry);
      } catch (err) {
        console.error("[LogStore] System log listener error:", err);
      }
    }
  }
  debug(
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.log("debug", category, message, metadata);
  }
  info(
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.log("info", category, message, metadata);
  }
  warn(
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.log("warn", category, message, metadata);
  }
  error(
    category: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.log("error", category, message, metadata);
  }
  getSystemLogs(filter?: SystemLogFilter): SystemLogEntry[] {
    let result = this.systemEntries;
    if (filter?.minLevel) {
      const minRank = LOG_LEVEL_RANK[filter.minLevel];
      result = result.filter((e) => LOG_LEVEL_RANK[e.level] >= minRank);
    }
    if (filter?.category) {
      result = result.filter((e) => e.category === filter.category);
    }
    if (filter?.since) {
      result = result.filter((e) => e.timestamp >= filter.since!);
    }
    return result.slice(0, filter?.limit ?? 100);
  }
  subscribeSystem(listener: (entry: SystemLogEntry) => void): () => void {
    this.systemListeners.add(listener);
    return () => {
      this.systemListeners.delete(listener);
    };
  }
  createEntry(
    id: string,
    model: string,
    stream: boolean,
    requestId?: string,
    accountEmail?: string,
  ): LogEntry {
    const entry: LogEntry = {
      id,
      timestamp: new Date().toISOString(),
      model,
      stream,
      accountEmail: accountEmail || "",
      // Structured log fields for external aggregators
      level: "info",
      request_id: requestId ?? id,
      latency_ms: null,
      tokens: null,
      clientRequest: {
        messageCount: 0,
        roles: [],
        hasTools: false,
        toolNames: [],
        tool_choice: null,
        lastMessage: "",
        messages: [],
      },
      promptToQwen: {
        systemPromptLength: 0,
        totalLength: 0,
        preview: "",
      },
      qwenRawChunks: [],
      rawFullContent: "",
      toolCallResults: [],
      parsedToolCalls: [],
      remainingText: "",
      processedApiOutput: "",
      finalResponse: {
        finishReason: "",
        toolCallCount: 0,
        contentPreview: "",
      },
      errors: [],
    };
    this.entries.unshift(entry);
    this.entryMap.set(entry.id, entry);
    if (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.pop();
      if (removed) this.entryMap.delete(removed.id);
    }
    return entry;
  }
  updateEntry(id: string, updater: (entry: LogEntry) => void): void {
    const entry = this.entryMap.get(id);
    if (!entry) return;
    updater(entry);
    for (const listener of this.listeners) {
      listener(entry);
    }
  }
  addRawChunk(id: string, chunk: string): void {
    this.updateEntry(id, (entry) => {
      if (entry.qwenRawChunks.length < MAX_CHUNKS_PER_ENTRY) {
        entry.qwenRawChunks.push(chunk);
      }
      if (entry.rawFullContent.length < MAX_FIELD_LENGTH) {
        entry.rawFullContent += chunk;
        if (entry.rawFullContent.length > MAX_FIELD_LENGTH) {
          entry.rawFullContent =
            entry.rawFullContent.substring(0, MAX_FIELD_LENGTH) +
            "... [truncated]";
        }
      }
    });
    // Persist to disk: append every chunk (no truncation) to chunk_stream.txt and raw_output.txt
    if (config.get("SAVE_REQUEST_LOGS") === "true") {
      const dir = this.ensureRequestDir(id);
      if (dir) {
        try {
          appendFileSync(join(dir, "chunk_stream.txt"), chunk + "\n");
          appendFileSync(join(dir, "raw_output.txt"), chunk);
        } catch {
          /* disk write best-effort */
        }
      }
    }
  }
  addProcessedOutput(id: string, content: string): void {
    this.updateEntry(id, (entry) => {
      if (entry.processedApiOutput.length < MAX_FIELD_LENGTH) {
        entry.processedApiOutput += content;
        if (entry.processedApiOutput.length > MAX_FIELD_LENGTH) {
          entry.processedApiOutput =
            entry.processedApiOutput.substring(0, MAX_FIELD_LENGTH) +
            "... [truncated]";
        }
      }
    });
    // Persist to disk: append processed content (no truncation)
    if (config.get("SAVE_REQUEST_LOGS") === "true") {
      const dir = this.ensureRequestDir(id);
      if (dir) {
        try {
          appendFileSync(join(dir, "processed_output.txt"), content);
        } catch {
          /* disk write best-effort */
        }
      }
    }
  }
  recordAmplificationEvent(
    logId: string,
    ratio: number,
    triggeringInput: string,
  ): void {
    this.updateEntry(logId, (entry) => {
      entry.amplificationRatio = ratio;
      entry.amplificationTriggeredInput =
        triggeringInput.length > 2000
          ? triggeringInput.substring(0, 2000) +
            `... [truncated ${triggeringInput.length - 2000} more chars]`
          : triggeringInput;
    });
  }

  getEntry(id: string): LogEntry | undefined {
    return this.entryMap.get(id);
  }
  addError(id: string, error: string): void {
    this.updateEntry(id, (entry) => {
      entry.errors.push(error);
    });
  }
  getRecent(count = 20): LogEntry[] {
    return this.entries.slice(0, count);
  }
  getAll(): LogEntry[] {
    return this.entries;
  }
  setNetworkTiming(id: string, timing: LogEntry["networkTiming"]): void {
    this.updateEntry(id, (entry) => {
      entry.networkTiming = timing;
    });
  }
  // SSE listener management
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  // Uptime in seconds since server start
  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.serverStartTime) / 1000);
  }
  recordModelError(model: string): void {
    _recordModelError(model);
  }
  recordModelSuccess(model: string): void {
    _recordModelSuccess(model);
  }
  getModelHealth(model: string): {
    errors: number;
    successes: number;
    errorRate: number;
    isHealthy: boolean;
  } {
    return _getModelHealth(model);
  }
  resetModelHealth(model: string): void {
    _resetModelHealth(model);
  }
  getAllModelHealth(): Record<
    string,
    { successCount: number; errorCount: number; lastActivity: string }
  > {
    return _getAllModelHealth();
  }
  private toolCallValidationFailures = 0;
  private hallucinatedToolNames = 0;
  /**
   * Increment counter for tool call validation failures
   * (e.g., JSON parse errors, schema mismatches, guard rejections)
   */
  recordToolCallValidationFailure(): void {
    this.toolCallValidationFailures++;
  }
  /**
   * Increment counter for hallucinated tool names
   * (e.g., model invents tool not in available_tools registry)
   */
  recordHallucinatedToolName(): void {
    this.hallucinatedToolNames++;
  }
  /**
   * Get tool discipline metrics for observability/Prometheus export
   */
  getToolDisciplineMetrics(): {
    toolCallValidationFailures: number;
    hallucinatedToolNames: number;
  } {
    return {
      toolCallValidationFailures: this.toolCallValidationFailures,
      hallucinatedToolNames: this.hallucinatedToolNames,
    };
  }
  /**
   * Reset tool discipline metrics (useful for testing or manual recovery)
   */
  resetToolDisciplineMetrics(): void {
    this.toolCallValidationFailures = 0;
    this.hallucinatedToolNames = 0;
  }
}
export const logStore = new LogStore();
