#!/usr/bin/env node
/**
 * qg - Qwen Gate CLI
 * 
 * Commands:
 *   qg                    Start the gateway server
 *   qg login <email>      Authenticate account
 *   qg restart            Restart the gateway server
 *   qg ulw [on|off]       Toggle ultrawork mode
 *   qg --help             Show this help
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { login as performLogin } from './login.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = resolve(__dirname, 'index.ts');

function showHelp() {
  const port = process.env.PORT || '26405';
  console.log(`
qg — Qwen Gate CLI

Usage:
  qg                    Start the gateway server
  qg start              Start the gateway server
  qg login <email>      Authenticate a Qwen account via browser
  qg restart            Restart the gateway server
  qg ulw [on|off]       Toggle ultrawork mode
  qg --help, -h         Show this help

Server starts on http://localhost:${port}
Dashboard: http://localhost:${port}/log
`.trim());
}

async function startServer() {
  const server = spawn('tsx', [SERVER_ENTRY], {
    stdio: 'inherit',
    shell: true,
  });

  server.on('error', (err) => {
    console.error('[qg] Failed to start server:', err.message);
    process.exit(1);
  });

  server.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

async function handleLogin(email: string) {
  if (!email || !email.includes('@')) {
    console.error('Error: Please provide a valid email address');
    console.error('Usage: qg login <user@example.com>');
    process.exit(1);
  }
  await performLogin(email);
}

async function restartServer() {
  
  const isWindows = process.platform === 'win32';
  const killCmd = isWindows 
    ? `taskkill /F /IM tsx.exe 2>nul || true`
    : `pkill -f "tsx.*index.ts" 2>/dev/null || true`;
  
  await new Promise<void>((resolve) => {
    const killer = spawn(killCmd, { shell: true, stdio: 'ignore' });
    killer.on('close', () => resolve());
  });
  
  await new Promise((r) => setTimeout(r, 500));
  await startServer();
}

async function toggleUltrawork(mode?: string) {
  const configPath = resolve(process.env.HOME || process.env.USERPROFILE || '.', '.qwen-gate', '.env');
  const enabled = mode !== 'off';
  
  if (existsSync(configPath)) {
    let content = readFileSync(configPath, 'utf-8');
    if (/^ULW_ENABLED=/m.test(content)) {
      content = content.replace(/^ULW_ENABLED=.*/m, `ULW_ENABLED=${enabled}`);
    } else {
      content += (content.endsWith('\n') ? '' : '\n') + `ULW_ENABLED=${enabled}\n`;
    }
    writeFileSync(configPath, content);
  } else {
    // intentional: config file doesn't exist yet, will be created on first use
  }
  
  if (enabled) {
    // intentional: no-op when enabling, server will pick up config on restart
  } else {
    // intentional: no-op when disabling, server will pick up config on restart
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    showHelp();
    process.exit(0);
  }
  
  const [command, ...rest] = args;
  
  switch (command) {
    case 'login':
      await handleLogin(args[0]);
      break;
    case 'restart':
      await restartServer();
      break;
    case 'ulw':
      await toggleUltrawork(rest[0]);
      break;
    case 'start':
    case 'run':
    case 'server':
      await startServer();
      break;
    default:
      if (command && !command.startsWith('-')) {
        console.error(`[qg] Unknown command: ${command}`);
        console.error('Run `qg --help` for available commands');
        process.exit(1);
      }
      await startServer();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[qg] Fatal error:', err);
    process.exit(1);
  });
}

export { startServer, handleLogin, restartServer, toggleUltrawork };