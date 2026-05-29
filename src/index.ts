import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { chatCompletions } from './routes/chat.ts';
import { fetchQwenModels, disableNativeTools, disablePersonalization } from './services/qwen.ts';
import * as dotenv from 'dotenv';
import { initPlaywright, BrowserType, getQwenHeaders, closePlaywright, getActivePage } from './services/playwright.ts';
import { initAuth, getAccountStats, getAccountCount, getAvailableCount, reloadAccounts } from './services/auth.ts';
import { accountsRouter } from './routes/accounts.ts';
import { sessionPool } from './services/sessionPool.ts';
import { networkInterfaces } from 'os';
import { resolve } from 'path';
import crypto from 'crypto';
import { logStore } from './services/logStore.ts';
import { logHtml as logHtmlTemplate } from './routes/logPage.ts';
import { startAutoCleanup, stopAutoCleanup } from './middleware/rateLimit.ts';

// Compare two strings in timing-constant fashion to prevent timing attacks on API key auth.
// Length mismatch is intentionally NOT early-returned to avoid leaking length information.
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Pad the shorter buffer so both are equal length for timingSafeEqual
  const maxLen = Math.max(bufA.length, bufB.length);
  const padA = Buffer.alloc(maxLen, 0);
  const padB = Buffer.alloc(maxLen, 0);
  bufA.copy(padA, maxLen - bufA.length);
  bufB.copy(padB, maxLen - bufB.length);
  try {
    return crypto.timingSafeEqual(padA, padB);
  } catch {
    return false;
  }
}

// Escape a string for safe embedding in a JS single-quoted string literal
function escapeJSString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Inject API_KEY into dashboard HTML for client-side auth
const logHtml = logHtmlTemplate.replace(
  '<script>',
  `<script>\nwindow.API_KEY = '${escapeJSString(process.env.API_KEY || '')}';`
);
import { stream as honoStream } from 'hono/streaming';
import { debugNetworkApp } from './routes/debugNetwork.ts';

dotenv.config();

export const app = new Hono();

let inFlightRequests = 0;
let isShuttingDown = false;
let serverInstance: ReturnType<typeof serve> | null = null;
const SHUTDOWN_TIMEOUT_MS = 30_000;

app.use('*', async (c, next) => {
  if (isShuttingDown) {
    return c.json({ error: { message: 'Server is shutting down' } }, 503);
  }
  inFlightRequests++;
  try {
    await next();
  } finally {
    inFlightRequests--;
  }
});

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Shutdown] ${signal} received again, forcing exit...`);
    process.exit(1);
  }
  isShuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received, in-flight: ${inFlightRequests}`);
  if (serverInstance) {
    try { (serverInstance as any).close?.(); } catch {}
  }
  if (inFlightRequests > 0) {
    const start = Date.now();
    while (inFlightRequests > 0 && (Date.now() - start) < SHUTDOWN_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try { await closePlaywright(); } catch (err: any) {
    console.error('[Shutdown] Playwright close error:', err.message);
  }
  stopAutoCleanup();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.use('*', cors());

// Helper to get local network IPs
function getNetworkAddress() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// API Key protection middleware
app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

app.use('/log*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return await next();
  // SSE endpoint: EventSource cannot send custom headers, accept token as query param
  if (c.req.path === '/log/stream') {
    const token = c.req.query('token');
    if (token && safeCompare(token, apiKey)) return await next();
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (c.req.path === '/log') return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

app.get('/dashboard', async (c) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompare(authHeader.slice(7), apiKey)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  return c.html(logHtml);
});

app.get('/', (c) => c.redirect('/log'));

// Basic health check
app.get('/health', (c) => {
  const pwOk = getActivePage() !== null;
  return c.json({
    status: pwOk ? 'ok' : 'degraded',
    playwright: pwOk,
    accounts: {
      total: getAccountCount(),
      available: getAvailableCount(),
    },
    uptime: process.uptime()
  }, pwOk ? 200 : 503);
});

// Account status — shows which accounts are active, throttled, etc.
app.get('/accounts', (c) => {
  return c.json(getAccountStats());
});

// Session pool stats — active sessions, waiting queue, etc.
app.get('/pool/stats', (c) => {
  return c.json(sessionPool.getStats());
});

app.post('/admin/accounts/reload', async (c) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompare(authHeader.slice(7), apiKey)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  try {
    await reloadAccounts();
    const stats = getAccountStats();
    return c.json({ success: true, accounts: stats.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

app.get('/system/logs', (c) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompare(authHeader.slice(7), apiKey)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const category = c.req.query('category');
  const minLevel = c.req.query('level') as 'debug' | 'info' | 'warn' | 'error' | undefined;
  return c.json(logStore.getSystemLogs({ limit, category, minLevel }));
});

app.get('/metrics/model-health', (c) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompare(authHeader.slice(7), apiKey)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  return c.json(logStore.getAllModelHealth());
});

app.get('/log', (c) => {
  return c.html(logHtml);
});

app.get('/log/json', (c) => {
  return c.json(logStore.getRecent(50));
});

app.get('/log/stream', (c) => {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const entry of logStore.getRecent(50)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
        }
        const unsub = logStore.subscribe((entry) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`)); } catch {}
        });
        const signal = c.req.raw?.signal;
        if (signal) {
          signal.addEventListener('abort', () => { unsub(); try { controller.close(); } catch {} });
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    }
  );
});

app.route('/debug/network', debugNetworkApp);

// Account CRUD API — protected by bearer auth
app.use('/api/accounts*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});
app.route('/api/accounts', accountsRouter);

// 10MB request body limit on all chat endpoints — MUST be registered before the route handler
const MAX_BODY_BYTES = 10 * 1024 * 1024;
app.use('/v1/chat/completions', async (c, next) => {
  const contentLength = Number(c.req.header('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: { message: 'Request body too large' } }, 413);
  }
  await next();
});

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', async (c) => {
  try {
    const models = await fetchQwenModels();
    return c.json({
      object: 'list',
      data: models
    });
  } catch (err: any) {
    return c.json({ error: { message: err.message } }, 500);
  }
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Parse browser type from args or env
  let browserType: BrowserType = 'chromium';
  const browserArg = process.argv.find(arg => arg.startsWith('--browser='));
  if (browserArg) {
    browserType = browserArg.split('=')[1] as BrowserType;
  } else if (process.env.BROWSER) {
    browserType = process.env.BROWSER as BrowserType;
  }

  // Enable log persistence — writes system logs and request-level raw/processed logs to disk
  logStore.enablePersistence(resolve(process.cwd(), 'logs'));

  initPlaywright(true, browserType).then(async () => {
    console.log(`Playwright initialized (${browserType}).`);

    // Initialize auth AFTER playwright so login uses browser context with WAF headers.
    // The auth service will use activePage.evaluate() for the API call when available,
    // giving us proper anti-bot headers and avoiding WAF blocks.
    // MUST await initAuth before pre-warming to avoid race condition where
    // AccountContext creation interferes with login flow.
    try {
      await initAuth();
    } catch (err: any) {
      console.warn('[Startup] initAuth failed:', err.message);
    }

    startAutoCleanup();

    console.log('[Startup] Pre-warming headers...');
    try {
      await getQwenHeaders();
      console.log('[Startup] Headers pre-warmed.');
    } catch (err: any) {
      console.warn('[Startup] Header pre-warm failed:', err.message);
    }

    await Promise.allSettled([
      disableNativeTools().catch(err => console.warn('[Startup] disableNativeTools failed:', err.message)),
      disablePersonalization().catch(err => console.warn('[Startup] disablePersonalization failed:', err.message)),
    ]);

    const port = parseInt(process.env.PORT || '26405', 10) || 26405;
    
    const networkIP = getNetworkAddress();
    
    console.log('\n🚀 Qwen Gate started!');
    console.log(`- Local:   http://localhost${port === 80 ? '' : ':' + port}`);
    console.log(`- Alias:   http://qwen-gate`);
    if (networkIP) {
      console.log(`- Network: http://${networkIP}${port === 80 ? '' : ':' + port}`);
    }

    console.log('\nAvailable Routes:');
    app.routes.forEach(route => {
      console.log(`- [${route.method}] ${route.path}`);
    });
    console.log('');

    serverInstance = serve({
      fetch: app.fetch,
      port,
      serverOptions: {
        requestTimeout: 600_000,      // 10 minutes — SSE streams can run long
        keepAliveTimeout: 75_000,     // 75 seconds
        headersTimeout: 65_000,       // 65 seconds (must be < requestTimeout)
      },
    });
    logStore.log('info', 'server', 'Server started on port ' + port);
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });

  // Expose uptime endpoint for dashboard
  app.get('/metrics/uptime', (c) => {
    return c.json({ uptimeSeconds: logStore.getUptimeSeconds() });
  });
}
