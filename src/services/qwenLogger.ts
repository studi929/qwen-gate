import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QwenPayload } from './qwen.ts';

const LOG_DIR = join(process.cwd(), 'logs', 'qwen');

function ensureDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function logQwenRequest(
  payload: QwenPayload,
  url: string,
): string {
  ensureDir();
  const timestamp = Date.now();
  const d = new Date(timestamp);
  const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const timeStr = `${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}-${String(d.getSeconds()).padStart(2,'0')}-${String(d.getMilliseconds()).padStart(3,'0')}`;
  const chatId = payload.chat_id || 'new';
  const shortChat = chatId.substring(0, 8);
  const filename = `${dateStr}_${timeStr}_${shortChat}_request.json`;
  const filepath = join(LOG_DIR, filename);
  writeFileSync(filepath, JSON.stringify(payload, null, 2));
  return filepath;
}

export function logQwenResponse(
  requestFile: string,
  status: number,
  statusText: string,
  headers: Record<string, string>,
  responsePreview: string,
): void {
  if (!existsSync(requestFile)) return;
  const responseFile = requestFile.replace('_request.json', '_response.json');
  const entry = {
    status,
    statusText,
    headers,
    responsePreview: responsePreview.substring(0, 2000),
    timestamp: Date.now(),
  };
  writeFileSync(responseFile, JSON.stringify(entry, null, 2));
}

export function logQwenSSE(
  requestFile: string,
  sseEvents: number,
  toolCallEvents: number,
  firstToolCallSample: any,
): void {
  if (!existsSync(requestFile)) return;
  const sseFile = requestFile.replace('_request.json', '_sse.json');
  const entry = {
    totalEvents: sseEvents,
    toolCallEvents,
    firstToolCallSample: firstToolCallSample || null,
    timestamp: Date.now(),
  };
  writeFileSync(sseFile, JSON.stringify(entry, null, 2));
}
