import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
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
import { APP_VERSION } from "../../utils/version.ts";

const serveHtml = (html: string) => (c: any) => {
  const scriptInjection = `<script>\nwindow.APP_VERSION = ${JSON.stringify(APP_VERSION)};\nwindow.API_KEY = ${JSON.stringify(config.get("API_KEY"))};\n</script>\n`;
  const output = html.replace(/(<script\b)/, scriptInjection + "$1");
  c.header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;");
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
    200,
  );
}

async function accountsReloadHandler(c: any) {

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

  const emails = getAllAccountEmails();
  if (!emails || emails.length === 0)
    return c.json({ error: "No accounts configured" }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let deleted = 0;
      const errors: string[] = [];
      const maskEmail = (e: string) => {
        const at = e.indexOf('@');
        return at > 0 ? e.slice(0, Math.min(at, 3)) + '***' + e.slice(at) : e;
      };
      for (const email of emails) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "progress", email: maskEmail(email), status: "deleting" })}\n\n`));
          await deleteAllChats(email);
          deleted++;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "progress", email: maskEmail(email), status: "done" })}\n\n`));
        } catch (err: any) {
          errors.push(`${maskEmail(email)}: ${err.message}`);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "progress", email: maskEmail(email), status: "error", error: err.message })}\n\n`));
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

function sanitizeLogEntry(entry: any): any {
  const sanitized = { ...entry };

  // Mask email addresses (keep first 3 chars)
  if (sanitized.accountEmail) {
    const [local, domain] = sanitized.accountEmail.split('@');
    sanitized.accountEmail = local.substring(0, 3) + '***@' + (domain || '***');
  }

  // Mask prompt content that might contain credentials
  if (sanitized.messages) {
    sanitized.messages = sanitized.messages.map((m: any) => {
      if (typeof m.content === 'string' && m.content.length > 200) {
        return { ...m, content: m.content.substring(0, 200) + '...[truncated]' };
      }
      return m;
    });
  }

  // Truncate rawRequestBody if present
  if (sanitized.rawRequestBody) {
    const rawStr = typeof sanitized.rawRequestBody === 'string'
      ? sanitized.rawRequestBody
      : JSON.stringify(sanitized.rawRequestBody);
    if (rawStr.length > 500) {
      sanitized.rawRequestBody = rawStr.substring(0, 500) + '...[truncated]';
    }
  }

  // Truncate long text fields that may contain sensitive data
  for (const field of ['rawFullContent', 'processedApiOutput', 'remainingText', 'amplificationTriggeredInput', 'rawResponse', 'input']) {
    if (typeof sanitized[field] === 'string' && sanitized[field].length > 500) {
      sanitized[field] = sanitized[field].substring(0, 500) + '...[truncated]';
    }
  }

  // Truncate prompt preview
  if (sanitized.promptToQwen?.preview && typeof sanitized.promptToQwen.preview === 'string') {
    sanitized.promptToQwen = {
      ...sanitized.promptToQwen,
      preview: sanitized.promptToQwen.preview.length > 200
        ? sanitized.promptToQwen.preview.substring(0, 200) + '...[truncated]'
        : sanitized.promptToQwen.preview,
    };
  }

  // Sanitize client request messages
  if (sanitized.clientRequest?.messages) {
    sanitized.clientRequest = {
      ...sanitized.clientRequest,
      messages: sanitized.clientRequest.messages.map((m: any) => {
        if (typeof m.content === 'string' && m.content.length > 200) {
          return { ...m, content: m.content.substring(0, 200) + '...[truncated]' };
        }
        return m;
      }),
    };
  }

  return sanitized;
}

function systemLogsHandler(c: any) {

  const limit = parseInt(c.req.query("limit") || "100", 10);
  const category = c.req.query("category");
  const minLevel = c.req.query("level") as "debug" | "info" | "warn" | "error" | undefined;
  const logs = logStore.getSystemLogs({ limit, category, minLevel });
  return c.json(logs.map(sanitizeLogEntry));
}

function modelHealthHandler(c: any) {
  return c.json(logStore.getAllModelHealth());
}

function logStreamHandler(c: any) {
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
          if (!safeEnqueue(`data: ${JSON.stringify(sanitizeLogEntry(entry))}\n\n`)) break;
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
          if (!safeEnqueue(`data: ${JSON.stringify(sanitizeLogEntry(entry))}\n\n`)) {
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
  return c.json(serialized.map(sanitizeLogEntry));
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
    return c.json(getAccountStats());
  });
  app.get("/pool/stats", (c) => {
    return c.json(sessionPool.getStats());
  });

  app.post("/admin/accounts/reload", async (c, next) => {
    const apiKey = config.get("API_KEY");
    if (!apiKey) return await next();
    return bearerAuth({ token: apiKey })(c, next);
  }, accountsReloadHandler);
  app.post("/dashboard/accounts/delete-all-chats", async (c, next) => {
    const apiKey = config.get("API_KEY");
    if (!apiKey) return await next();
    return bearerAuth({ token: apiKey })(c, next);
  }, deleteAllChatsHandler);

  app.get("/system/logs", systemLogsHandler);
  app.get("/metrics/model-health", modelHealthHandler);

  app.get("/log", (c) => c.redirect("/dashboard/logs"));
  app.get("/log/json", logJsonHandler);
  app.get("/log/stream", logStreamHandler);
  app.get("/metrics/uptime", (c) => {
    return c.json({ uptimeSeconds: logStore.getUptimeSeconds() });
  });

  app.get("/api/config", (c) => {
    const all = config.getAll();
    const safe = Object.fromEntries(Object.entries(all).filter(([k]) => !['API_KEY'].includes(k)));
    return c.json({ config: safe });
  });

  app.put("/api/config", async (c) => {
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
