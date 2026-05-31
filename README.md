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
- **Rate limiting** — per-account request tracking
- **Live debug dashboard** — `/log` shows raw vs processed output, per-chunk inspection, SSE live updates, and folded sections

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/youssefvdel/qwen-gate/main/install.sh | bash
cd qwen-gate && npm start
```

Or manually:

```bash
git clone https://github.com/youssefvdel/qwen-gate.git
cd qwen-gate
npm install
cp .env.example .env
npm start     # Starts on http://localhost:26405
# CloakBrowser stealth binary auto-downloads on first launch (~200MB)
```

## Usage

```bash
# List models
curl http://localhost:26405/v1/models

# Chat (streaming)
curl -N -X POST http://localhost:26405/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "qwen3.7-max", "messages": [{"role": "user", "content": "hello"}], "stream": true}'

# Tool calling
curl -N -X POST http://localhost:26405/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.7-max",
    "messages": [{"role": "user", "content": "read /etc/hostname"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file",
        "parameters": {
          "type": "object",
          "properties": {"path": {"type": "string"}},
          "required": ["path"]
        }
      }
    }],
    "stream": true
  }'
```

## Environment Variables

| Variable              | Required | Description                                                  |
| --------------------- | -------- | ------------------------------------------------------------ |
| `API_KEY`             | No       | Bearer token to authenticate client requests                 |
| `PORT`                | No       | HTTP port (default `26405`)                                  |
| `QWEN_EMAIL`          | No       | Qwen account email for auto-login                            |
| `QWEN_PASSWORD`       | No       | Qwen account password for auto-login                         |
| `LOG_LEVEL`           | No       | `debug` / `info` / `warn` / `error` (default `info`)         |
| `SESSION_POOL_SIZE`   | No       | Max concurrent Playwright sessions (default `3`)              |

## Architecture

```
Client (OpenAI SDK, curl, etc.)
         │
         ▼
  ┌──────────────┐
  │  Hono HTTP   │   /v1/chat/completions, /v1/models
  │   Server     │   /log (dashboard), /system/logs
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │  Session     │   Per-account CloakBrowser contexts
   │   Manager    │   (58 C++ stealth patches) · Autoscaling + rotation
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │   Qwen       │   chat.qwen.ai via intercepted browser requests
  │   Backend    │
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │  Pipeline    │   ToolSpamGuard · content filter · echo filter
  │              │   streaming deltas · token estimation
  └──────────────┘
```

### Request Flow

1. Client POSTs to `/v1/chat/completions` with OpenAI-format payload
2. Session manager picks an authenticated Playwright session (rotating across accounts)
3. Outbound browser request is intercepted and rewritten to Qwen's internal format
4. Response streams back through the pipeline:
   - **ToolSpamGuard** — sliding-window dedup rejects repeated `(tool, args)` calls and injects correction feedback on the next turn
   - **Content filter** — strips tool-call artifacts, XML leaks, and streaming JSON fragments while preserving code whitespace
   - **Streaming deltas** — incremental emission with snapshot diffing; flush path aligns with streaming state to prevent duplication
5. Final response is formatted as an OpenAI-compatible SSE stream or JSON object

## Dashboard

Visit `http://localhost:26405/log` for a live debug dashboard:

- Request log with per-entry foldable sections (raw chunks, raw AI response, processed output)
- Live SSE updates as requests stream in
- System logs panel with level/category filtering
- Color-coded chunk types (tool vs text) and full content inspection

## Testing

```bash
npm test
```

Uses the `node:test` runner. Tests cover content filtering, tool-call parsing, echo detection, and spam guard behavior.

## License

[MIT](./LICENSE)
