import { Hono } from "hono";
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { config, isValidKey } from "../../services/configService.ts";
import { logStore } from "../../services/logStore.ts";
import { sessionPool } from "../../services/sessionPool.ts";
import {
  getAccountStats,
  getAccountCount,
  getAvailableCount,
  getAllAccountEmails,
  initAuth,
} from "../../services/auth.ts";
import { checkApiKeyAuth, safeCompare } from "../../utils/auth.ts";
import { projectPath } from "../../utils/paths.ts";
import {
  deleteAllChats,
  configureAccount,
} from "../../services/qwen.ts";
import { getActivePage } from "../../services/playwright.ts";
import { overviewHtml } from "./overview.ts";
import { logsHtml } from "./logs.ts";
import { accountsHtml } from "./accounts.ts";
import { networkHtml } from "./network.ts";
import { settingsHtml } from "./settings.ts";

const serveHtml = (html: string) => (c: any) => {
  const apiKey = config.get("API_KEY");
  const appVersion = "0.2.0";
  const scriptInjection = `<script>\nwindow.APP_VERSION = '${appVersion}';\n${apiKey ? `window.API_KEY = '${apiKey.replace(/'/g, "\\'")}';\n` : ""}`;
  const output = html.replace("<script>", scriptInjection);
  return c.html(output);
};

function dashboardStaticHandler(c: any) {
  const file = c.req.param("file");
  if (!/^[a-z0-9_-]+\.(css|js)$/i.test(file)) return c.json({ error: "Invalid file" }, 400);
  const DASHBOARD_STATIC = projectPath("src", "routes", "dashboard", "public");
  const filePath = resolve(DASHBOARD_STATIC, file);
  if (!filePath.startsWith(DASHBOARD_STATIC) || !existsSync(filePath)) return c.json({ error: "Not found" }, 404);
  const ext = file.endsWith(".css") ? "text/css" : "application/javascript";
  return c.text(readFileSync(filePath, "utf-8"), 200, { "Content-Type": ext });
}

function healthHandler(c: any) {
  const pwOk = getActivePage() !== null;
  return c.json(
    {
      status: pwOk ? "ok" : "degraded",
      playwright: pwOk,
      accounts: { total: getAccountCount(), available: getAvailableCount() },
      uptime: process.uptime(),
    },
    pwOk ? 200 : 503,
  );
}

async function accountsReloadHandler(c: any) {
  const auth = checkApiKeyAuth(c);
  if (auth) return auth;

  try {
    await initAuth(async (email) => {
      logStore.log("info", "account", `Reloading ${email}`);
      await configureAccount(email);
    });
    logStore.log("info", "auth", "Accounts reloaded");
    return c.json({ ok: true });
  } catch (err: any) {
    logStore.log("error", "auth", `Reload failed: ${err.message}`);
    return c.json({ error: err.message }, 500);
  }
}

async function deleteAllChatsHandler(c: any) {
  const auth = checkApiKeyAuth(c);
  if (auth) return auth;

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
}

function systemLogsHandler(c: any) {
  const auth = checkApiKeyAuth(c);
  if (auth) return auth;

  const limit = parseInt(c.req.query("limit") || "100", 10);
  const category = c.req.query("category");
  const minLevel = c.req.query("level") as "debug" | "info" | "warn" | "error" | undefined;
  return c.json(logStore.getSystemLogs({ limit, category, minLevel }));
}

function modelHealthHandler(c: any) {
  const auth = checkApiKeyAuth(c);
  if (auth) return auth;
  return c.json(logStore.getAllModelHealth());
}

function logStreamHandler(c: any) {
  const auth = checkApiKeyAuth(c);
  if (auth) return auth;
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

        for (const entry of logStore.getRecent(50)) {
          if (!safeEnqueue(`data: ${JSON.stringify(entry)}\n\n`)) break;
        }

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

        const unsub = logStore.subscribe((entry) => {
          if (!safeEnqueue(`data: ${JSON.stringify(entry)}\n\n`)) {
            unsub();
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* stream already lost */ }
          }
        });

        const signal = c.req.raw?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            alive = false;
            unsub();
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* stream already lost */ }
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
}

function logJsonHandler(c: any) {
  const auth = checkApiKeyAuth(c);
  if (auth) return auth;
  const entries = logStore.getRecent(50);
  const serialized = entries.map((e) => {
    const dt = new Date(e.timestamp);
    const datePart = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const timePart = `${String(dt.getHours()).padStart(2, "0")}-${String(dt.getMinutes()).padStart(2, "0")}-${String(dt.getSeconds()).padStart(2, "0")}`;
    return {
      id: e.id,
      date: datePart,
      time: timePart,
      timestamp: e.timestamp,
      stream: e.stream,
      accountEmail: e.accountEmail,
      latency_ms: e.latency_ms,
      tokens: e.tokens,
      request_id: e.request_id,
      errors: e.errors?.length > 0 ? e.errors : undefined,
      model: e.model,
      turnId: e.turnId || "",
      raw_output: e.rawFullContent || "",
      processed_output: {
        content: e.processedApiOutput || "",
        tool_calls: (e.parsedToolCalls || []).map((tc) => {
          let args: unknown = tc.args;
          try { args = JSON.parse(tc.args); } catch { /* keep as string */ }
          return { name: tc.name, arguments: args };
        }),
      },
      chunks: (e.qwenRawChunks || []) as string[],
      finalResponse: e.finalResponse || undefined,
      remainingText: e.remainingText || undefined,
      promptToQwen: e.promptToQwen || undefined,
      rawRequestBody: e.rawRequestBody || undefined,
      networkTiming: e.networkTiming || undefined,
      amplificationRatio: e.amplificationRatio,
      amplificationTriggeredInput: e.amplificationTriggeredInput || undefined,
      input: e.input || undefined,
      client_request: e.clientRequest || {},
    };
  });
  return c.json(serialized);
}

export function registerDashboardRoutes(app: Hono): void {
  app.get("/dashboard", serveHtml(overviewHtml));
  app.get("/dashboard/logs", serveHtml(logsHtml));
  app.get("/dashboard/accounts", serveHtml(accountsHtml));
  app.get("/dashboard/network", serveHtml(networkHtml));
  app.get("/dashboard/settings", serveHtml(settingsHtml));

  app.get("/dashboard/static/:file", dashboardStaticHandler);

  app.get("/", (c) => c.redirect("/dashboard"));
  app.get("/health", healthHandler);
  app.get("/accounts", (c) => {
    const auth = checkApiKeyAuth(c);
    if (auth) return auth;
    return c.json(getAccountStats());
  });
  app.get("/pool/stats", (c) => {
    const auth = checkApiKeyAuth(c);
    if (auth) return auth;
    return c.json(sessionPool.getStats());
  });

  app.post("/admin/accounts/reload", accountsReloadHandler);
  app.post("/dashboard/accounts/delete-all-chats", deleteAllChatsHandler);

  app.get("/system/logs", systemLogsHandler);
  app.get("/metrics/model-health", modelHealthHandler);

  app.get("/log", (c) => c.redirect("/dashboard/logs"));
  app.get("/log/json", logJsonHandler);
  app.get("/log/stream", logStreamHandler);
  app.get("/metrics/uptime", (c) => {
    const auth = checkApiKeyAuth(c);
    if (auth) return auth;
    return c.json({ uptimeSeconds: logStore.getUptimeSeconds() });
  });

  app.get("/api/config", (c) => {
    const apiKey = config.get("API_KEY");
    if (apiKey) {
      const authHeader = c.req.header("authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ") || !safeCompare(authHeader.slice(7), apiKey)) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    return c.json({ config: config.getAll() });
  });

  app.put("/api/config", async (c) => {
    const apiKey = config.get("API_KEY");
    if (apiKey) {
      const authHeader = c.req.header("authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ") || !safeCompare(authHeader.slice(7), apiKey)) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    try {
      const body = await c.req.json();
      let changed = false;
      for (const key of Object.keys(body)) {
        if (typeof body[key] === "string" && isValidKey(key)) {
          config.set(key, body[key]);
          changed = true;
        }
      }
      if (changed) config.save();
      return c.json({ config: config.getAll() });
    } catch {
      return c.json({ error: "invalid request body" }, 400);
    }
  });
}
