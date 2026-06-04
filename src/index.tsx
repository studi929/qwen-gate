import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import { chatCompletions } from "./routes/chat.ts";
import {
  fetchQwenModels,
  configureAccount,
  deleteAllChats,
} from "./services/qwen.ts";
import {
  initPlaywright,
  BrowserType,
  getQwenHeaders,
  closePlaywright,
  getActivePage,
} from "./services/playwright.ts";
import {
  initAuth,
  getAccountStats,
  getAccountCount,
  getAvailableCount,
  reloadAccounts,
  getAllAccountEmails,
} from "./services/auth.ts";
import { accountsRouter } from "./routes/accounts.ts";
import { configRouter } from "./routes/config.ts";
import { sessionPool } from "./services/sessionPool.ts";
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";
import { logStore } from "./services/logStore.ts";
import { config } from "./services/configService.ts";
import { startAutoCleanup, stopAutoCleanup } from "./middleware/rateLimit.ts";

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

import { debugNetworkApp } from "./routes/debugNetwork.ts";
import { overviewHtml } from "./routes/dashboard/overview.ts";
import { logsHtml } from "./routes/dashboard/logs.ts";
import { accountsHtml } from "./routes/dashboard/accounts.ts";
import { networkHtml } from "./routes/dashboard/network.ts";
import { settingsHtml } from "./routes/dashboard/settings.ts";

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
let serverInstance: ReturnType<typeof serve> | null = null;
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
  if (serverInstance) {
    try {
      serverInstance.close();
    } catch {
      // intentional: server close failure during shutdown is non-blocking, continue cleanup
    }
  }
  if (inFlightRequests > 0) {
    const start = Date.now();
    while (inFlightRequests > 0 && Date.now() - start < SHUTDOWN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    await closePlaywright();
  } catch (err: any) {
    console.error("[Shutdown] Playwright close error:", err.message);
  }
  stopAutoCleanup();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

app.use("*", cors());

// API Key protection middleware
app.use("/v1/*", async (c, next) => {
  const apiKey = config.get("API_KEY");
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

app.use("/log*", async (c, next) => {
  const apiKey = config.get("API_KEY");
  if (!apiKey) return await next();
  // SSE endpoint: EventSource cannot send custom headers, accept token as query param
  if (c.req.path === "/log/stream") {
    const token = c.req.query("token");
    if (token && safeCompare(token, apiKey)) return await next();
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (c.req.path === "/log") return await next();
  return bearerAuth({ token: apiKey })(c, next);
});

const serveHtml = (html: string) => (c: any) => {
  const apiKey = config.get("API_KEY");
  const output = apiKey
    ? html.replace(
        "<script>",
        `<script>\nwindow.API_KEY = '${apiKey.replace(/'/g, "\\'")}';\n`,
      )
    : html;
  return c.html(output);
};

// Serve individual dashboard pages per route
app.get("/dashboard", serveHtml(overviewHtml));
app.get("/dashboard/logs", serveHtml(logsHtml));
app.get("/dashboard/accounts", serveHtml(accountsHtml));
app.get("/dashboard/network", serveHtml(networkHtml));
app.get("/dashboard/settings", serveHtml(settingsHtml));

// Serve dashboard static files (CSS, JS)
const DASHBOARD_STATIC = resolve(process.cwd(), "src", "routes", "dashboard", "public");
app.get("/dashboard/static/:file", (c) => {
  const file = c.req.param("file");
  if (!/^[a-z0-9_-]+\.(css|js)$/i.test(file)) return c.json({ error: "Invalid file" }, 400);
  const filePath = resolve(DASHBOARD_STATIC, file);
  if (!filePath.startsWith(DASHBOARD_STATIC) || !existsSync(filePath)) return c.json({ error: "Not found" }, 404);
  const ext = file.endsWith(".css") ? "text/css" : "application/javascript";
  return c.text(readFileSync(filePath, "utf-8"), 200, { "Content-Type": ext });
});

// Serve per-request log files from disk (input.json, raw_output.txt, processed_output.txt, chunk_stream.txt)
const ALLOWED_LOG_FILES = new Set([
  "input.json",
  "raw_output.txt",
  "processed_output.txt",
  "chunk_stream.txt",
]);
app.get("/dashboard/logs/:id/:file", (c) => {
  const logDir = logStore.getRequestLogDir();
  if (!logDir)
    return c.json({ error: "Request file logging not enabled" }, 503);
  const id = c.req.param("id");
  const file = c.req.param("file");
  if (!ALLOWED_LOG_FILES.has(file))
    return c.json({ error: "Invalid file" }, 400);
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    return c.json({ error: "Invalid request ID" }, 400);
  const filePath = resolve(logDir, "requests", id, file);
  if (!existsSync(filePath)) return c.json({ error: "File not found" }, 404);
  const content = readFileSync(filePath, "utf-8");
  const contentType = file.endsWith(".json")
    ? "application/json"
    : "text/plain";
  return c.text(content, 200, { "Content-Type": contentType });
});

// Root redirect
app.get("/", (c) => c.redirect("/dashboard"));

// Basic health check
app.get("/health", (c) => {
  const pwOk = getActivePage() !== null;
  return c.json(
    {
      status: pwOk ? "ok" : "degraded",
      playwright: pwOk,
      accounts: {
        total: getAccountCount(),
        available: getAvailableCount(),
      },
      uptime: process.uptime(),
    },
    pwOk ? 200 : 503,
  );
});

// Account status — shows which accounts are active, throttled, etc.
app.get("/accounts", (c) => {
  return c.json(getAccountStats());
});

// Session pool stats — active sessions, waiting queue, etc.
app.get("/pool/stats", (c) => {
  return c.json(sessionPool.getStats());
});

app.post("/admin/accounts/reload", async (c) => {
  const apiKey = config.get("API_KEY");
  if (apiKey) {
    const authHeader = c.req.header("authorization");
    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ") ||
      !safeCompare(authHeader.slice(7), apiKey)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  const { getQwenHeaders } =
    (await import("../services/playwright.ts")) as typeof import("../services/playwright.ts");
  try {
    await initAuth(async (email) => {
      const { headers } = (await getQwenHeaders!(email))!;
      const headersArr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
      logStore.log("info", "account", `Reloading ${email}`);
      await configureAccount(email, headersArr, "");
    });
    logStore.log("info", "auth", "Accounts reloaded");
    return c.json({ ok: true });
  } catch (err: any) {
    logStore.log("error", "auth", `Reload failed: ${err.message}`);
    return c.json({ error: err.message }, 500);
  }
});

app.post("/dashboard/accounts/delete-all-chats", async (c) => {
  const apiKey = config.get("API_KEY");
  if (apiKey) {
    const authHeader = c.req.header("authorization");
    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ") ||
      !safeCompare(authHeader.slice(7), apiKey)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  const emails = getAllAccountEmails();
  if (!emails || emails.length === 0)
    return c.json({ error: "No accounts configured" }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let deleted = 0;
      const errors: string[] = [];
      for (const email of emails) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "progress", email, status: "deleting" })}\n\n`));
          await deleteAllChats(email);
          deleted++;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "progress", email, status: "done" })}\n\n`));
        } catch (err: any) {
          errors.push(`${email}: ${err.message}`);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "progress", email, status: "error", error: err.message })}\n\n`));
        }
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "result", ok: true, deleted, total: emails.length, errors: errors.length ? errors : undefined })}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
});

app.get("/system/logs", (c) => {
  const apiKey = config.get("API_KEY");
  if (apiKey) {
    const authHeader = c.req.header("authorization");
    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ") ||
      !safeCompare(authHeader.slice(7), apiKey)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  const limit = parseInt(c.req.query("limit") || "100", 10);
  const category = c.req.query("category");
  const minLevel = c.req.query("level") as
    | "debug"
    | "info"
    | "warn"
    | "error"
    | undefined;
  return c.json(logStore.getSystemLogs({ limit, category, minLevel }));
});

app.get("/metrics/model-health", (c) => {
  const apiKey = config.get("API_KEY");
  if (apiKey) {
    const authHeader = c.req.header("authorization");
    if (
      !authHeader ||
      !authHeader.startsWith("Bearer ") ||
      !safeCompare(authHeader.slice(7), apiKey)
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  return c.json(logStore.getAllModelHealth());
});

app.get("/log", (c) => c.redirect("/dashboard/logs"));

app.get("/log/json", (c) => {
  return c.json(logStore.getRecent(10));
});

app.get("/log/stream", (c) => {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let alive = true;
        const safeEnqueue = (data: string): boolean => {
          if (!alive) return false;
          try {
            controller.enqueue(encoder.encode(data));
            return true;
          } catch {
            alive = false;
            return false;
          }
        };

        // Send recent history
        for (const entry of logStore.getRecent(50)) {
          if (!safeEnqueue(`data: ${JSON.stringify(entry)}\n\n`)) break;
        }

        // Heartbeat to prevent browser/proxy from dropping idle connections
        const heartbeat = setInterval(() => {
          if (!alive) {
            clearInterval(heartbeat);
            return;
          }
          if (!safeEnqueue(": ping\n\n")) {
            clearInterval(heartbeat);
          }
        }, 15000);
        heartbeat.unref();

        // Subscribe to all log updates — frontend deduplicates by ID
        const unsub = logStore.subscribe((entry) => {
          if (!safeEnqueue(`data: ${JSON.stringify(entry)}\n\n`)) {
            unsub();
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              // intentional: stream close failure during abort is non-blocking, connection already lost
            }
          }
        });

        const signal = c.req.raw?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            alive = false;
            unsub();
            clearInterval(heartbeat);
            try {
              controller.close();
            } catch {
              // intentional: stream close failure during abort is non-blocking, connection already lost
            }
          });
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
});

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
    if (!auth || auth !== `Bearer ${config.get("API_KEY")}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
}
app.route("/api/config", configRouter);

// 10MB request body limit on all chat endpoints — MUST be registered before the route handler
const MAX_BODY_BYTES = 10 * 1024 * 1024;
app.use("/v1/chat/completions", async (c, next) => {
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: { message: "Request body too large" } }, 413);
  }
  await next();
});

// OpenAI compatible routes
app.post("/v1/chat/completions", chatCompletions);

app.get("/v1/models", async (c) => {
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
import { fileURLToPath } from "url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let browserType: BrowserType = "chromium";
  const browserArg = process.argv.find((arg) => arg.startsWith("--browser="));
  if (browserArg) {
    browserType = browserArg.split("=")[1] as BrowserType;
  } else if (config.get("BROWSER")) {
    browserType = config.get("BROWSER") as BrowserType;
  }

  // Enable per-request file logging
  logStore.enableRequestFileLogging(resolve(process.cwd(), "logs"));

  const port = parseInt(config.get("PORT"), 10) || 26405;

  // Show banner immediately on startup
  console.log("");
  console.log(
    `  \x1b[31m\x1b[1m████████▄    ▄█     █▄     ▄████████ ███▄▄▄▄   \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m███    ███  ███     ███   ███    ███ ███▀▀▀██▄ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m███    ███  ███     ███   ███    █▀  ███   ███ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m███    ███  ███     ███  ▄███▄▄▄     ███   ███ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m███    ███  ███     ███ ▀▀███▀▀▀     ███   ███ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m███    ███  ███     ███   ███    █▄  ███   ███ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m███  ▀ ███  ███ ▄█▄ ███   ███    ███ ███   ███ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m ▀██████▀▄█  ▀███▀███▀    ██████████  ▀█   █▀ \x1b[0m`,
  );
  console.log("");
  console.log(
    `  \x1b[31m\x1b[1m   ▄██████▄     ▄████████     ███        ▄████████ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m  ███    ███   ███    ███ ▀█████████▄   ███    ███ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m  ███    █▀    ███    ███    ▀███▀▀██   ███    █▀  \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m ▄███          ███    ███     ███   ▀  ▄███▄▄▄     \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m▀▀███ ████▄  ▀███████████     ███     ▀▀███▀▀▀     \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m  ███    ███   ███    ███     ███       ███    █▄  \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m  ███    ███   ███    ███     ███       ███    ███ \x1b[0m`,
  );
  console.log(
    `  \x1b[31m\x1b[1m  ████████▀    ███    █▀     ▄████▀     ██████████ \x1b[0m`,
  );
  console.log("");
  console.log(
    `  \x1b[32m\x1b[1m●\x1b[0m \x1b[90mPort:\x1b[0m \x1b[36m${port}\x1b[0m`,
  );
  console.log(
    `  \x1b[32m\x1b[1m●\x1b[0m \x1b[90mAPI:\x1b[0m \x1b[36mlocalhost:${port}/v1\x1b[0m`,
  );
  console.log(
    `  \x1b[32m\x1b[1m●\x1b[0m \x1b[90mDashboard:\x1b[0m \x1b[36mhttp://localhost:${port}/dashboard\x1b[0m \x1b[90m(Ctrl+Click)\x1b[0m`,
  );
  console.log("");

  const APP_VERSION = "0.2.0";

  async function checkForUpdates(): Promise<void> {
    try {
      const res = await fetch(
        "https://api.github.com/repos/youssefvdel/qwen-gate/releases/latest",
        { signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) return;
      const data: any = await res.json();
      const latest = (data.tag_name || "").replace(/^v/, "");
      if (latest && latest !== APP_VERSION) {
        logStore.log("warn", "server",
          `Update available: v${APP_VERSION} → v${latest}. Run "curl -sSL https://raw.githubusercontent.com/youssefvdel/qwen-gate/main/install.sh | bash" to update.`,
        );
      }
    } catch { /* network error — skip */ }
  }

  initPlaywright(true, browserType)
    .then(async () => {
      // ── Phase 1: Start HTTP server FIRST so dashboard is live immediately ──
      serverInstance = serve({
        fetch: app.fetch,
        port,
        serverOptions: {
          requestTimeout: 600_000,
          keepAliveTimeout: 75_000,
          headersTimeout: 65_000,
        },
      });
      logStore.log("info", "server", "Server started on port " + port);

      checkForUpdates().catch(() => {});

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
        console.log(
          `  \x1b[32m\x1b[1m✔\x1b[0m \x1b[90mAll background initialization complete\x1b[0m`,
        );
      })().catch((err) => {
        logStore.log("error", "boot", `Background init error: ${err.message}`);
      });
    })
    .catch((err: any) => {
      console.error("Failed to initialize playwright:", err);
      process.exit(1);
    });

  // Expose uptime endpoint for dashboard
  app.get("/metrics/uptime", (c) => {
    return c.json({ uptimeSeconds: logStore.getUptimeSeconds() });
  });
}
