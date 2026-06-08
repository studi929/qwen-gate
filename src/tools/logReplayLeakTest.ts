import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { StreamingToolParser } from './parser.ts';
import { stripToolCallArtifacts } from '../utils/xmlStripper.ts';

const LEAK_PATTERNS: RegExp[] = [
  // Qwen XML tool call format
  /<function=[^\s>]+>/,
  /<\/function\s*>/,
  /<function_calls\s*>/,
  /<\/function_calls\s*>/,
  /<parameter=[^\s>]+>/,
  /<\/parameter\s*>/,
  // Claude XML format
  /<invoke\s+name=/,
  /<\/invoke\s*>/,
  // Legacy XML tool call artifacts
  /<tool_call[^>]*>/,
  /<\/tool_call\s*>/,
  /<tool_result[^>]*>/,
  /<\/tool_result\s*>/,
  // JSON tool call/result artifacts
  /\{"name"\s*:/,
  /"arguments"\s*:/,
  /\[{"type":"text","text":"/,
];

function checkForLeaks(text: string): string[] {
  const found: string[] = [];
  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(text)) found.push(pattern.source);
  }
  return found;
}

function replayLog(filePath: string): { leaks: string[]; toolCalls: number; file: string } {
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));
  const chunks = data.chunks || [];
  const processedOriginal = data.processed_output?.content || '';

  const parser = new StreamingToolParser();
  let feedText = '';
  const allCalls: any[] = [];

  for (const chunk of chunks) {
    const result = parser.feed(chunk);
    feedText += result.text;
    allCalls.push(...result.toolCalls);
  }

  const flushResult = parser.flush();
  const flushText = flushResult.text;
  allCalls.push(...flushResult.toolCalls);

  const allText = feedText + flushText;
  const filtered = stripToolCallArtifacts(allText);

  const feedLeaks = checkForLeaks(feedText);
  const flushLeaks = checkForLeaks(flushText);
  const filteredLeaks = checkForLeaks(filtered);
  const reProcessedLeaks = checkForLeaks(processedOriginal);
  const allLeaks = [...new Set([...feedLeaks, ...flushLeaks, ...filteredLeaks, ...reProcessedLeaks])];

  const stillLeaks = filteredLeaks.length > 0;

  if (stillLeaks) {
    console.log(`\n[LEAK] ${filePath.split('/').pop()} (CLIENT-FACING):`);
    console.log(`  stripToolCallArtifacts missed: ${filteredLeaks.join(', ')}`);
    console.log(`  toolCalls: ${allCalls.length}`);
  } else if (feedLeaks.length || flushLeaks.length) {
    console.log(`[OK]   ${filePath.split('/').pop()}: ${allCalls.length} tool calls, intermediate XML (caught by filter)`);
  } else if (reProcessedLeaks.length > 0) {
    console.log(`[FIXED] ${filePath.split('/').pop()}: historical processed_output had ${reProcessedLeaks.join(', ')} — current code is clean`);
  }

  return { leaks: stillLeaks ? filteredLeaks : [], toolCalls: allCalls.length, file: filePath };
}

function run(logDir: string): { total: number; leaks: number; results: Array<{ file: string; leaks: string[]; toolCalls: number }> } {
  if (!existsSync(logDir)) {
    console.log(`No logs directory found at ${logDir}. Set SAVE_REQUEST_LOGS=true and make some requests first.`);
    return { total: 0, leaks: 0, results: [] };
  }

  const files = readdirSync(logDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log(`No log files found in ${logDir}/`);
    return { total: 0, leaks: 0, results: [] };
  }

  const results: Array<{ file: string; leaks: string[]; toolCalls: number }> = [];
  let totalLeaks = 0;

  for (const file of files) {
    const result = replayLog(join(logDir, file));
    results.push(result);
    if (result.leaks.length > 0) {
      console.log(`[LEAK] ${file}: ${result.leaks.join(', ')} (${result.toolCalls} tool calls)`);
      totalLeaks += result.leaks.length;
    } else if (result.toolCalls > 0) {
      console.log(`[OK]   ${file}: ${result.toolCalls} tool calls, no leaks`);
    } else {
      console.log(`[SKIP] ${file}: no tool calls`);
    }
  }

  console.log(`\nTotal: ${files.length} files, ${totalLeaks} leaks found`);
  return { total: files.length, leaks: totalLeaks, results };
}

const logsDir = join(process.cwd(), 'logs');
const result = run(logsDir);
if (result.leaks > 0) {
  console.log(`FAIL: ${result.leaks} client-facing leak(s) found`);
  process.exit(1);
} else {
  console.log('PASS: No client-facing leaks');
}
