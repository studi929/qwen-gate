import 'dotenv/config';
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import { chatCompletions } from "./routes/chat.ts";
import { fetchQwenModels, configureAccount } from "./services/qwen.ts";
import {
  initPlaywright,
  BrowserType,
  getQwenHeaders,
  closePlaywright,
  getBrowser,
} from "./services/playwright.ts";
import { initAuth } from "./services/auth.ts";
import { accountsRouter } from "./routes/accounts.ts";
import { configRouter } from "./routes/config.ts";
import { logStore } from "./services/logStore.ts";
import { config } from "./services/configService.ts";
import { startAutoCleanup, stopAutoCleanup, rateLimitMiddleware } from "./middleware/rateLimit.ts";
import { debugNetworkApp } from "./routes/debugNetwork.ts";
import { registerDashboardRoutes } from "./routes/dashboard/dashboardRoutes.ts";
import { projectPath } from "./utils/paths.ts";
import { fileURLToPath } from "url";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { safeCompare } from "./utils/auth.ts";

// ── Runtime detection ───────────────────────────────────────────────
const isBun = typeof Bun !== 'undefined';

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
});

console.clear();
process.stdout.write("\x1bc\x1b[3J\x1b[2J\x1b[H");

// Redirect all console warn/error to dashboard system logs instead of terminal
const _origWarn = console.warn;
const _origError = console.error;
console.warn = (...args: any[]) => {
  const msg = args.map((a: any) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  logStore.log("warn", "system", msg);
};
console.error = (...args: any[]) => {
  const msg = args.map((a: any) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  logStore.log("error", "system", msg);
};

export const app = new Hono();

let inFlightRequests = 0;
let isShuttingDown = false;
let serverStop: (() => void | Promise<void>) | null = null;
const SHUTDOWN_TIMEOUT_MS = 30_000;

app.use("*", async (c, next) => {
  if (isShuttingDown) {
    return c.json({ error: { message: "Server is shutting down" } }, 503);
  }
  inFlightRequests++;
  try {
    await next();
  } finally {
    inFlightRequests--;
  }
});

async function gracefulShutdown(_signal: string): Promise<void> {
  if (isShuttingDown) {
    process.exit(1);
  }
  isShuttingDown = true;
  if (serverStop) {
    try { await serverStop(); } catch { /* intentional */ }
  }
  if (inFlightRequests > 0) {
    const start = Date.now();
    while (inFlightRequests > 0 && Date.now() - start < SHUTDOWN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { await closePlaywright(); } catch (err: any) { console.error("[Shutdown] Playwright close error:", err.message); }
  stopAutoCleanup();
  const pidFile = projectPath('.qwen', 'gate.pid');
  try { if (existsSync(pidFile)) unlinkSync(pidFile); } catch { /* best effort */ }
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

app.use("*", cors({ origin: ['http://localhost:26405', 'http://127.0.0.1:26405'] }));

// Health check — reports actual system status (Playwright readiness, uptime)
app.get('/health', (c) => {
  const browser = getBrowser();
  const playwrightReady = browser !== null;
  return c.json({
    status: playwrightReady ? 'ok' : 'degraded',
    playwright: playwrightReady,
    uptime: process.uptime(),
  });
});
// Ping — lightweight static response
const PING_RESPONSE = new Response('OK', {
  status: 200,
  headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' },
});
app.get('/ping', () => PING_RESPONSE);

// API Key protection for OpenAI-compatible routes
app.use("/v1/*", async (c, next) => {
  const apiKey = config.get("API_KEY");
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

registerDashboardRoutes(app);

app.route("/debug/network", debugNetworkApp);

// Account CRUD API — protected by bearer auth
app.use("/api/accounts*", async (c, next) => {
  const apiKey = config.get("API_KEY");
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});
app.route("/api/accounts", accountsRouter);

// Config API
if (config.get("API_KEY")) {
  configRouter.use("*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth || !auth.startsWith("Bearer ") || !safeCompare(auth.slice(7), config.get("API_KEY"))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
}
app.route("/api/config", configRouter);

// 10MB request body limit on all chat endpoints
const MAX_BODY_BYTES = 10 * 1024 * 1024;
app.use("/v1/chat/completions", async (c, next) => {
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: { message: "Request body too large" } }, 413);
  }
  await next();
});

app.post("/v1/chat/completions", async (c, next) => {
  const result = await rateLimitMiddleware(c, 'chat-completions');
  if (result) return result;
  await next();
}, chatCompletions);

app.get("/v1/models", async (c, next) => {
  const result = await rateLimitMiddleware(c, 'models');
  if (result) return result;
  await next();
}, async (c) => {
  try {
    const models = await fetchQwenModels();
    return c.json({
      object: "list",
      data: models,
    });
  } catch (err: any) {
    return c.json({ error: { message: err.message } }, 500);
  }
});

// Initialize playwright when server starts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let browserType: BrowserType = "chromium";
  const browserArg = process.argv.find((arg) => arg.startsWith("--browser="));
  if (browserArg) {
    browserType = browserArg.split("=")[1] as BrowserType;
  } else if (config.get("BROWSER")) {
    browserType = config.get("BROWSER") as BrowserType;
  }

  // Enable per-request file logging
  logStore.enableRequestFileLogging(projectPath("logs", "gate"));

  const port = parseInt(config.get("PORT"), 10) || 26405;
  const hostArg = process.argv.indexOf('--host');
  const host = hostArg !== -1 && process.argv[hostArg + 1]
    ? process.argv[hostArg + 1]
    : config.get("HOST") || "localhost";

  // Show banner immediately on startup
  process.stdout.write(`\x1b[31m
████████▄    ▄█     █▄     ▄████████ ███▄▄▄▄
███    ███  ███     ███   ███    ███ ███▀▀▀██▄
███    ███  ███     ███   ███    █▀  ███   ███
███    ███  ███     ███  ▄███▄▄▄     ███   ███
███    ███  ███     ███ ▀▀███▀▀▀     ███   ███
███    ███  ███     ███   ███    █▄  ███   ███
███  ▀ ███  ███ ▄█▄ ███   ███    ███ ███   ███
 ▀██████▀▄█  ▀███▀███▀    ██████████  ▀█   █▀

   ▄██████▄     ▄████████     ███        ▄████████
  ███    ███   ███    ███ ▀█████████▄   ███    ███
  ███    █▀    ███    ███    ▀███▀▀██   ███    █▀
 ▄███          ███    ███     ███   ▀  ▄███▄▄▄
▀▀███ ████▄  ▀███████████     ███     ▀▀███▀▀▀
  ███    ███   ███    ███     ███       ███    █▄
  ███    ███   ███    ███     ███       ███    ███
  ████████▀    ███    █▀     ▄████▀     ██████████

  \x1b[0m\x1b[32m●\x1b[0m Host: ${host}
  \x1b[32m●\x1b[0m Port: ${port}
  \x1b[32m●\x1b[0m API: ${host}:${port}/v1
  \x1b[32m●\x1b[0m Dashboard: http://${host}:${port}/dashboard (Ctrl+Click)\x1b[0m
  `);

  initPlaywright(true, browserType)
    .then(async () => {
      // ── Phase 1: Start HTTP server FIRST so dashboard is live immediately ──
      try {
        if (isBun) {
          // Bun native HTTP server — faster, no adapter needed
          const bunServer = Bun.serve({
            fetch: app.fetch,
            port,
            hostname: host,
            idleTimeout: 0,  // disable idle timeout for SSE streaming
          });
          serverStop = () => bunServer.stop(false);  // graceful drain
        } else {
          // Node.js fallback via @hono/node-server
          const { serve } = await import('@hono/node-server');
          const nodeServer = serve({
            fetch: app.fetch,
            port,
            hostname: host,
            serverOptions: {
              requestTimeout: 600_000,
              keepAliveTimeout: 75_000,
              headersTimeout: 65_000,
            },
          });
          serverStop = () => new Promise<void>((resolve) => nodeServer.close(() => resolve()));
        }
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
          const fallbackPort = port + 1;
          console.warn(`Port ${port} in use, trying ${fallbackPort}...`);
          if (isBun) {
            const bunServer = Bun.serve({
              fetch: app.fetch,
              port: fallbackPort,
              hostname: host,
              idleTimeout: 0,
            });
            serverStop = () => bunServer.stop(false);
          } else {
            const { serve } = await import('@hono/node-server');
            const nodeServer = serve({
              fetch: app.fetch,
              port: fallbackPort,
              hostname: host,
              serverOptions: {
                requestTimeout: 600_000,
                keepAliveTimeout: 75_000,
                headersTimeout: 65_000,
              },
            });
            serverStop = () => new Promise<void>((resolve) => nodeServer.close(() => resolve()));
          }
        } else { throw err; }
      }

      // Pre-warm DNS and TCP connection to Qwen upstream
      if (isBun) {
        try {
          // @ts-ignore — Bun-specific API
          Bun.dns?.prefetch?.('chat.qwen.ai', 443);
          // @ts-ignore
          fetch.preconnect?.('https://chat.qwen.ai');
          logStore.log('info', 'boot', 'DNS prefetch + TCP preconnect initiated');
        } catch {
          // Not all Bun versions support these — silently skip
        }
      }

      const pidFile = projectPath('.qwen', 'gate.pid');
      try { writeFileSync(pidFile, String(process.pid)); } catch { /* best effort */ }
      logStore.log("info", "server", `Server started on ${host}:${port}`);

      if (config.get("OPEN_DASHBOARD_ON_START") === "true") {
        const { exec } = await import("child_process");
        const url = `http://localhost:${port}/dashboard`;
        const cmd = process.platform === "darwin" ? `open "${url}"`
          : process.platform === "win32" ? `start "" "${url}"`
          : `xdg-open "${url}"`;
        exec(cmd);
        logStore.log("info", "server", `Opening dashboard at ${url}`);
      }
      startAutoCleanup();

      // Force GC after Playwright init — browser profile loading allocates heavily
      if (isBun) {
        Bun.gc(true);
        logStore.log('info', 'boot', 'GC triggered after Playwright init');
      }

      logStore.log(
        "info",
        "boot",
        "Dashboard live — starting background initialization...",
      );

      // ── Phase 2: Auth + post-boot tasks run in background ──
      (async () => {
        logStore.log("info", "boot", "[1/5] Authenticating accounts...");
        try {
          await initAuth(async (email) => {
            await configureAccount(email);
          });
          logStore.log(
            "info",
            "boot",
            "[1/5] Accounts authenticated + configured",
          );
        } catch (err: any) {
          logStore.log("warn", "boot", `[1/5] initAuth failed: ${err.message}`);
        }

        logStore.log("info", "boot", "[2/5] Pre-warming headers...");
        try {
          await getQwenHeaders();
          logStore.log("info", "boot", "[2/5] Headers ready");
        } catch (err: any) {
          logStore.log(
            "warn",
            "boot",
            `[2/5] Header pre-warm failed: ${err.message}`,
          );
        }

        logStore.log("info", "boot", "All background initialization complete");
      })().catch((err) => {
        logStore.log("error", "boot", `Background init error: ${err.message}`);
      });
    })
    .catch((err: any) => {
      console.error("Failed to initialize playwright:", err);
      process.exit(1);
    });
}
