#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, 'index.tsx');
const DIST_ENTRY = resolve(__dirname, '..', 'dist', 'index.js');

function log(msg: string) { console.log(`[qg] ${msg}`); }
function err(msg: string) { console.error(`[qg] ${msg}`); }

function showHelp() {
  log('');
  log('Qwen Gate — OpenAI-compatible gateway for Qwen AI');
  log('');
  log('USAGE');
  log('  qg [command] [options]');
  log('');
  log('COMMANDS');
  log('  start          Start the API server (default)');
  log('  restart        Restart the running server');
  log('  status         Check if the server is running');
  log('  help           Show this help message');
  log('');
  log('OPTIONS');
  log('  --port <n>     Override port (default: from config or 26405)');
  log('  --browser <e>  Browser engine: chromium, firefox, chrome, edge');
  log('  --host <addr>  Bind address (default: from config or localhost)');
  log('');
  log('EXAMPLES');
  log('  qg                    Start the server');
  log('  qg start --port 8080  Start on port 8080');
  log('  qg restart            Restart the server');
  log('  qg status             Check server status');
  log('  qg help               Show this message');
  log('');
  log('ACCOUNT MANAGEMENT');
  log('  Use the web dashboard at http://localhost:26405/dashboard/accounts');
  log('  to add, remove, and manage your Qwen accounts.');
  log('');
}

function findEntry(): string {
  if (SERVER_ENTRY.endsWith('.tsx')) return SERVER_ENTRY;
  if (DIST_ENTRY.endsWith('.js')) return DIST_ENTRY;
  return SERVER_ENTRY;
}

async function startServer(args: string[]) {
  const portIdx = args.indexOf('--port');
  const browserIdx = args.indexOf('--browser');
  const hostIdx = args.indexOf('--host');

  const extraArgs: string[] = [];
  if (portIdx !== -1 && args[portIdx + 1]) extraArgs.push('--port', args[portIdx + 1]);
  if (browserIdx !== -1 && args[browserIdx + 1]) extraArgs.push('--browser', args[browserIdx + 1]);
  if (hostIdx !== -1 && args[hostIdx + 1]) extraArgs.push('--host', args[hostIdx + 1]);

  const entry = findEntry();
  const runner = entry.endsWith('.tsx') ? 'tsx' : 'node';

  log(`Starting server (${runner} ${entry})...`);
  if (extraArgs.length) log(`Extra args: ${extraArgs.join(' ')}`);

  const server = spawn(runner, [entry, ...extraArgs], {
    stdio: 'inherit',
    shell: true,
  });

  server.on('error', (e) => { err(`Failed to start: ${e.message}`); process.exit(1); });
  server.on('exit', (code) => process.exit(code ?? 0));
}

async function checkStatus() {
  const port = process.env.PORT || '26405';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    if (res.ok) {
      log(`Server is running on port ${port}`);
      return;
    }
  } catch {
    // Server not running
  }
  err('Server is not running');
  process.exit(1);
}

async function restartServer() {
  const isWin = process.platform === 'win32';
  const killCmd = isWin
    ? 'taskkill /F /IM tsx.exe 2>nul; taskkill /F /IM node.exe 2>nul || exit 0'
    : 'pkill -f "tsx.*index.ts" 2>/dev/null; pkill -f "node.*dist/index.js" 2>/dev/null; exit 0';

  log('Stopping server...');
  await new Promise<void>((resolve) => {
    const p = spawn(killCmd, { shell: true, stdio: 'ignore' });
    p.on('close', () => resolve());
  });

  await new Promise((r) => setTimeout(r, 1000));
  log('Starting server...');
  await startServer([]);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('--')) || 'start';

  if (command === 'help' || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case 'restart':
      await restartServer();
      break;
    case 'status':
      await checkStatus();
      break;
    case 'start':
    case 'run':
    case 'server':
      await startServer(args);
      break;
    default:
      log(`Starting server... (unknown command '${command}' — defaulting to start)`);
      await startServer(args);
      break;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).endsWith('cli.ts')) {
  main().catch((e) => { err(`Fatal: ${e.message}`); process.exit(1); });
}

export { startServer, restartServer };
