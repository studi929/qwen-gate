# Qwen Gate

> **⚠️ Disclaimer**: This project is for **educational and study purposes only**. It is an OpenAI-compatible API gateway that interfaces with Qwen models via `chat.qwen.ai`. The project is not affiliated with, endorsed by, or sponsored by Alibaba Group, Qwen, or `chat.qwen.ai`. All Qwen models and the `chat.qwen.ai` service are the property of their respective owners. Users are responsible for complying with `chat.qwen.ai`'s terms of service. The author assumes no responsibility for misuse, unauthorized access, or any violations of third-party terms.

OpenAI-compatible API gateway for **Qwen models (chat.qwen.ai)** using Playwright browser automation. Supports tool calling, thinking/reasoning, streaming, session autoscaling, multi-account management, and full OpenAI-compatible response formatting.

## Features

- **OpenAI-compatible API** — `/v1/chat/completions` and `/v1/models` with streaming + non-streaming
- **Tool calling** — full function/tool schema support with validation, spam detection, and correction feedback
- **Thinking / reasoning** — `<think>` block handling and emission
- **Multi-account sessions** — CloakBrowser-backed per-account browser contexts with automatic rotation
- **Session autoscaling** — concurrent sessions spun up under load
- **Streaming SSE** — incremental delta emission, heartbeat keep-alive, and content-filter integrity across stream boundaries
- **Content filter** — strips tool-call artifacts, streaming JSON fragment leaks, and XML leaks while preserving code whitespace
- **Token estimation** — context window validation with accurate token counting
- **Rate limiting** — per-account cooldown tracking with configurable throttle
- **Echo detection** — detects when the model parrots tool results and signals a network-level retry to the OpenAI SDK
- **Live dashboard** — Astro-powered web UI at `/dashboard` with request logs, account status, and session pool stats

## Quick Start

```bash
npm install
npm run setup        # interactive config wizard → writes .env
npm run dev          # starts API + Astro dashboard
```

The wizard walks you through setting the port, API key, and browser engine. Visit `http://localhost:26405/v1` once running.

## Configuration

Configuration uses `config.json` (created via `npm run setup` or the dashboard settings page). Environment variables still work but `config.json` takes precedence for most values.

```jsonc
{
  "PORT": 26405,
  "HOST": "localhost",
  "API_KEY": "sk-your-api-key",
  "BROWSER": "chromium",
  "BROWSER_HEADLESS": true,
  "LOG_LEVEL": "info",
  "LOG_FORMAT": "text",
  "LOG_MAX_ENTRIES": 20,
  "DASHBOARD": true,
  "TOOL_CALLING": true,
  "CONTENT_FILTER": true,
  "ECHO_DETECTOR": true,
  "ECHO_JACCARD_THRESHOLD": 0.9,
  "RATE_LIMIT_COOLDOWN_MS": 120000,
  "RETRY_ENABLED": true,
  "RETRY_MAX_ATTEMPTS": 3,
  "DELETE_SESSION": true
}
```

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `26405` | Proxy server port |
| `HOST` | `localhost` | Bind host. Use `0.0.0.0` to expose on all interfaces. |
| `API_KEY` | *(empty)* | Protects `/v1/*` endpoints. Clients send as `Authorization: Bearer <key>`. Leave empty for no auth. |

### Echo Detector

| Variable | Default | Description |
|----------|---------|-------------|
| `ECHO_DETECTOR` | `true` | Enable the streaming echo detector. When enabled, if the model repeats tool output verbatim mid-stream, the connection drops and the SDK retries on a fresh session with a correction prompt. Set `false` to disable. |
| `ECHO_JACCARD_THRESHOLD` | `0.9` | Bidirectional shingle containment threshold (0.0–1.0). Higher = stricter detection. At 0.9, output must share ≥90% of 5-gram shingles with a tool result line in both directions to trigger. |
| `ECHO_MIN_LINE_LENGTH` | `20` | Minimum line length in characters for echo comparison. Shorter lines are skipped (too few shingles for reliable matching). |
| `ECHO_MIN_UNIQUE_SHINGLES` | `8` | Minimum unique 5-gram shingles required for a line to be checked. |

### Browser Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER` | `chromium` | Browser backend: `chromium` (bundled), `firefox`, `chrome`, or `edge` (system installs). |

### Qwen Account Management

Accounts are **not** configured via env vars. They live in persistent storage (`data/accounts.json`) and are managed via the `/accounts` API or the dashboard UI.

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_COOLDOWN_MS` | `120000` | Cooldown duration (ms) when an account is rate-limited. |
| `QWEN_FETCH_TIMEOUT_MS` | `30000` | Timeout (ms) for Qwen API fetch requests. |
| `AUTH_REFRESH_BEFORE_MS` | `300000` | Refresh the auth token this many ms before it expires (default 5 min). |
| `AUTH_TOKEN_MAX_AGE_MS` | `28800000` | Force a token refresh when the token is older than this (default 8 h). |
| `DELETE_SESSION` | `true` | Delete chat sessions on Qwen's backend when the pool releases them. Set to `false` to keep history for debugging. |

### Output / Pipeline Control

These control how the Qwen response is transformed before being sent back to the client.

| Variable | Default | Description |
|----------|---------|-------------|
| `TOOL_CALLING` | `true` | Parse tool invocations and apply schema validation. Set `false` to pass Qwen's raw output through unchanged. |
| `MAX_TOOL_CALLS_PER_RESPONSE` | `3` | Maximum identical `(tool, args)` calls allowed per response before the spam guard kicks in. |
| `CONTENT_FILTER` | `true` | Strip tool-call artifacts, XML leaks, and thinking block noise. |
| `CLEAN_OUTPUT` | `true` | Strip backticks and collapse whitespace in parser output (only when `TOOL_CALLING=true`). |
| `STREAMING` | *(client)* | Force streaming: `true` = always stream, `false` = never stream. Unset = respect the client's `stream` field. |
| `NON_STREAMING` | *(unset)* | Set to `true` to force non-streaming mode (legacy alias). |

### Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD` | `true` | Enable the web dashboard at `/dashboard`. Set `false` to disable. |
| `ASTRO_PORT` | `4321` | Astro dev server port. |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG` | *(unset)* | Enable verbose debug logging — shows raw Qwen chunks vs processed output. |
| `DEBUG_STREAM` | *(unset)* | Debug streaming pipeline only, without full `DEBUG` noise. |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`. Automatically set to `debug` if `DEBUG=true`. |
| `LOG_FORMAT` | `text` | Set to `json` for JSON-lines output (useful for log aggregators). |
| `LOG_MAX_ENTRIES` | `20` | Max visible entries in the log page / log stream. Controls both in-memory storage and SSE batch size. |

### Upstream Retry

Controls how the gateway retries failed requests to the Qwen API (backoff with jitter).

| Variable | Default | Description |
|----------|---------|-------------|
| `RETRY_ENABLED` | `true` | Master switch for upstream retries. Set `false` to disable. |
| `RETRY_MAX_ATTEMPTS` | `3` | Maximum retry attempts per upstream request. |
| `RETRY_BASE_DELAY_MS` | `1000` | Base delay between retries (ms). |
| `RETRY_MAX_DELAY_MS` | `30000` | Maximum delay between retries (ms). |
| `RETRY_BACKOFF_MULTIPLIER` | `2` | Exponential backoff multiplier. |

### Testing (internal)

| Variable | Description |
|----------|-------------|
| `TEST_MOCK_PLAYWRIGHT` | Set by the test suite to mock Playwright. Do not set in production. |
| `TEST_SESSION_ID` | Mock session ID returned when `TEST_MOCK_PLAYWRIGHT` is set. |

## Usage

### Streaming chat completion

```bash
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-max",
    "stream": true,
    "messages": [{"role": "user", "content": "Explain quicksort"}]
  }'
```

### Tool calling

```bash
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-max",
    "messages": [{"role": "user", "content": "What is the weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          },
          "required": ["city"]
        }
      }
    }]
  }'
```

### List models

```bash
curl http://localhost:26405/v1/models
```

## Architecture

```
                    ┌──────────────┐
                    │  OpenAI      │
                    │  Client      │
                    └──────┬───────┘
                           │  POST /v1/chat/completions
                           ▼
            ┌──────────────────────────────────┐
            │  Hono API Server (PORT=26405)    │
            │  /v1/chat/completions            │
            │  /v1/models                      │
            │  /accounts                       │
            │  /health  /pool/stats            │
            │  /log/stream  /system/logs       │
            └─────────┬───────────┬────────────┘
                      │           │
               API    │           │  Dashboard
                      ▼           ▼
   ┌────────────────────────┐  ┌──────────────────────────────┐
   │  Session Pool          │  │  Astro Web Dashboard         │
   │  ─ autoscaling         │  │  /dashboard                  │
   │  ─ multi-account       │  │  ├─ /overview    (KPI+pool)  │
   │  ─ rotation + recycle  │  │  ├─ /logs        (requests)  │
   └───────────┬────────────┘  │  ├─ /accounts    (CRUD)      │
               │               │  ├─ /network     (debug)     │
               ▼               │  └─ /settings    (config)    │
   ┌────────────────────────┐  └──────────────────────────────┘
   │  Playwright Handler    │
   │  req rewrite → response│
   └───────────┬────────────┘
               │
               ▼
   ┌────────────────────────┐
   │  Response Pipeline     │
   │  ToolSpamGuard ·       │
   │  content filter ·      │
   │  echo filter ·         │
   │  streaming deltas ·    │
   │  token estimation      │
   └────────────────────────┘
```

### Request Flow

1. Client POSTs to `/v1/chat/completions` with OpenAI-format payload
2. Session pool picks an authenticated Playwright session (rotating across accounts)
3. Outbound browser request is intercepted and rewritten to Qwen's internal format
4. Response streams back through the pipeline:
   - **ToolSpamGuard** — sliding-window dedup rejects repeated `(tool, args)` calls and injects correction feedback on the next turn
   - **Content filter** — strips tool-call artifacts, XML leaks, and streaming JSON fragments while preserving code whitespace
   - **Echo filter** — detects when the model parrots tool results; aborts the upstream writer so the OpenAI SDK retries on a fresh session with a correction prompt injected
   - **Streaming deltas** — incremental emission with snapshot diffing; flush path aligns with streaming state to prevent duplication
5. Final response is formatted as an OpenAI-compatible SSE stream or JSON object

## Dashboard

The web dashboard is available at `http://localhost:<PORT>/dashboard` (enabled by default, disable with `DASHBOARD=false`). It auto-refreshes every 2 seconds with live SSE updates as requests stream in.

Navigate between pages using the sidebar on the left. The sidebar shows a green live indicator when the server is running and displays the server uptime at the bottom.

### Pages

#### Overview (`/dashboard`)

The landing page shows the system status at a glance:

- **KPI Cards** -- Total Accounts, Authenticated, Active Sessions, Queue depth, Total Requests, and Uptime
- **Session Pool** -- Active, Waiting, Available, and Total session counts with a utilization bar (color-coded: green below 50%, yellow 50-80%, red above 80%)
- **Model Health** -- Per-model success/error counts and success rate badges for each Qwen model used
- **System Logs** -- Recent server log entries with timestamps, level badges (debug/info/warn/error), and category labels

#### Logs (`/dashboard/logs`)

A live request log that streams entries via SSE as they arrive:

- Each entry shows model name, stream mode (SSE vs SYNC), status badge (done/streaming/error), token count, and account email
- **Input section** (folded by default) -- the full messages array sent by the client, color-coded by role (system, user, tool, assistant)
- **Raw Output** and **Processed Output** panels displayed side by side for comparison
- **Tool Calls** section lists every parsed tool invocation with name, arguments, blocked/error/success status, execution time, and result
- **Chunk Stream** panel (right column) shows every raw chunk from Qwen, color-coded by type (tool vs text) with index labels
- Errors are highlighted at the top with WARN (echo/loop) or ERROR badges
- A connection status indicator shows SSE health (Connected/Reconnecting/Disconnected)
- Load More button reveals older entries beyond the visible limit of 10
- Clear button to wipe the log

#### Accounts (`/dashboard/accounts`)

Manage Qwen accounts through a form and table interface:

- **Add Account** form -- enter email and password, then click Add Account. The server attempts an automated login and shows a success or warning toast
- **Accounts table** -- lists every account with:
  - Email address
  - Auth status indicator (green dot = authenticated, red = expired, yellow = throttled, gray = not authenticated)
  - In-flight request count
  - Total requests served
  - Throttle badge with remaining cooldown time
  - Token TTL countdown
  - **Remove** button (with confirmation modal) deletes the account and its session data
  - **Login** button (visible when not authenticated) opens a browser window for manual sign-in; the session is captured automatically once you log in on the Qwen page
- The table polls every 2 seconds for live updates

#### Network (`/dashboard/network`)

Debug panel that shows all outbound HTTP requests made by the Playwright browser layer to `chat.qwen.ai`:

- Table columns: Time, Method (GET/POST/PUT/DELETE), URL, Status code, Duration
- Each row is expandable -- click to reveal Request Headers, Request Body, Response Headers, Response Body, and Stream Chunks
- **Filter controls** at the top: filter by HTTP method, status range (2xx/4xx/5xx), or request category (chat, auth, models, session-create, session-delete, settings, other)
- Entries show their phase badge (pending/streaming/completed/error)
- Duration cells are color-coded: green for fast, yellow for slow
- Shows an empty state message when no data has been recorded yet (normal -- data only appears when requests are actively flowing through the gateway)

#### Settings (`/dashboard/settings`)

Edit all server configuration parameters through a web form:

- Sections match the env var groups: Server, Pipeline, Echo Detection, Auth, Logging, Retry
- Input types adapt to the setting: text fields, number fields, dropdown selects, and checkboxes
- Click **Save Changes** to persist. The server applies the new config on the fly -- no restart needed for most values
- Success/error messages appear inline and as toast notifications
- The config is stored in `config.json` alongside the project

## CLI Commands

The `qg` CLI is available after installing the package (`npm install -g .` or running via `npx` from the project root). It can also be invoked as `qwengate` or `qwen-gate`.

```
Usage: qg [command] [options]

Commands:
  start              Start the API server (default)
  login <email>      Authenticate a Qwen account via browser
  restart            Restart the running server
  status             Check if the server is running
  help               Show help message

Options:
  --port <n>         Override port (default: from config or 26405)
  --browser <e>      Browser engine: chromium, firefox, chrome, edge
  --host <addr>      Bind address (default: from config or localhost)
```

### Examples

**Start the server on the default port:**

```bash
qg
# [qg] Starting server (tsx src/index.tsx)...
```

**Start on a specific port with a different browser:**

```bash
qg start --port 8080 --browser firefox
# [qg] Starting server (tsx src/index.tsx)...
# [qg] Extra args: --port 8080 --browser firefox
```

**Login a Qwen account (opens a browser window for manual sign-in):**

```bash
qg login user@example.com
# [qg] Authenticating user@example.com...
# A browser window will open. Log in to chat.qwen.ai, then press Enter.
# [qg] Login complete. You can now use this account with Qwen Gate.
```

The login command launches a CloakBrowser persistent context pointing to `chat.qwen.ai/auth`. A browser window opens where you sign in manually. After logging in, press Enter in the terminal. The session cookies are saved automatically. Account credentials can also be added through the Dashboard at `/dashboard/accounts`.

**Check server status:**

```bash
qg status
# [qg] Server is running on port 26405 (PID: 12345)
```

When the server is not running:

```bash
qg status
# [qg] Server is not running
```

**Restart the server:**

```bash
qg restart
# [qg] Stopping server...
# [qg] Starting server (tsx src/index.tsx)...
```

**Show help:**

```bash
qg help
# [qg]
# [qg] Qwen Gate -- OpenAI-compatible gateway for Qwen AI
# [qg]
# [qg] USAGE
# [qg]   qg [command] [options]
# ...

## Troubleshooting

### Browser automation fails

The gateway requires a working browser engine to communicate with `chat.qwen.ai`. If you see errors about browser launch failures:

- **Check that Playwright browsers are installed.** Run `npx playwright install chromium` (or `firefox`, `chrome`, `edge` depending on your `BROWSER` setting).
- **System dependencies may be missing.** On Linux, run `npx playwright install-deps chromium` to install shared library dependencies (libnss3, libatk-bridge, etc.).
- **CloakBrowser persistent contexts** require a writable profile directory. Make sure the `data/` folder exists and is writable.
- **Headless mode** is used by default for API requests, but login (`qg login`) always opens a visible window. If you are in a headless server environment, use the `/dashboard/accounts` page to add accounts with credentials instead of the browser-based login flow.
- **Set `BROWSER_HEADLESS=false`** in config.json if you need to debug the browser behavior visually during API calls.

### Account authentication errors

- **Session expired.** Qwen auth tokens expire after 8 hours by default (configurable via `AUTH_TOKEN_MAX_AGE_MS`). If requests start failing with 401 errors, re-authenticate the account through the Dashboard at `/dashboard/accounts` -- click the Login button next to the affected account.
- **Invalid credentials.** If automated login fails, the Dashboard will show a "Login failed" toast. Try adding the account again with the correct password, or use the manual browser login flow.
- **Missing accounts.** The session pool has no sessions to serve requests if no accounts are added. Add at least one account via the Dashboard or the `/accounts` API. Run `curl http://localhost:26405/accounts` to verify.
- **Token refresh fails.** The gateway refreshes tokens automatically every 5 minutes before expiry. If this process fails, check the system logs in the Dashboard overview page for refresh errors. Network connectivity to `chat.qwen.ai` is required.

### Rate limiting issues

Qwen's backend may rate-limit accounts when too many requests are sent in a short window:

- **The Dashboard shows a yellow "Throttled" badge** on the Accounts page with a countdown timer. Wait for the cooldown to expire (default: 2 minutes, configurable via `RATE_LIMIT_COOLDOWN_MS`).
- **The session pool rotates to another account** automatically when one is throttled. If all accounts are throttled, requests queue up (visible on the Overview page Queue KPI).
- **Reduce concurrency** by lowering the number of parallel requests. The session pool autoscales but each account can only handle one request at a time.
- **Adjust cooldown timing** by increasing `RATE_LIMIT_COOLDOWN_MS` in the Dashboard Settings page to give accounts more recovery time.

### Network page shows no data

The Network debug panel at `/dashboard/network` displays outbound HTTP requests made by the Playwright browser layer. If it shows an empty state:

- **This is normal when no requests are active.** Data only appears when API calls are flowing through the gateway. Make a test request to `/v1/chat/completions` first.
- **Network capture is per-session.** If the session pool recycled all sessions before you opened the page, historical data may not be available. The panel shows up to the last 50 entries.
- **Check that the browser engine is running.** If the session pool shows zero active sessions, no network data will be captured.

### General debugging tips

- **Enable debug logging** by setting `DEBUG=true` in config.json or via the Settings page. This prints raw Qwen chunks alongside processed output.
- **Stream debugging only** -- set `DEBUG_STREAM=true` for streaming pipeline details without full debug noise.
- **Check the System Logs panel** on the Dashboard overview page for server-level errors and warnings.
- **Log format** can be switched to `json` (`LOG_FORMAT=json`) for structured logging compatible with log aggregators like ELK or Datadog.

## Testing

```bash
npm test
```

Uses the `node:test` runner. Tests cover content filtering, tool-call parsing, echo detection, and spam guard behavior. The `TEST_MOCK_PLAYWRIGHT` env var is set internally by the test suite to mock the browser layer.

## License

[MIT](./LICENSE)
