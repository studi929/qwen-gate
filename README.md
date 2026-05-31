# Qwen Gate

> **⚠️ Disclaimer**: This project is for **educational and study purposes only**. It is an OpenAI-compatible API gateway that interfaces with Qwen models via `chat.qwen.ai`. The project is not affiliated with, endorsed by, or sponsored by Alibaba Group, Qwen, or `chat.qwen.ai`. All Qwen models and the `chat.qwen.ai` service are the property of their respective owners. Users are responsible for complying with `chat.qwen.ai`'s terms of service. The author assumes no responsibility for misuse, unauthorized access, or any violations of third-party terms.

OpenAI-compatible API gateway for **Qwen models (chat.qwen.ai)** using Playwright browser automation. Supports tool calling, thinking/reasoning, streaming, session autoscaling, multi-account management, and full OpenAI-compatible response formatting.

## Features

- **OpenAI-compatible API** — `/v1/chat/completions` and `/v1/models` with streaming + non-streaming
- **Tool calling** — full function/tool schema support with validation, spam detection, and correction feedback
- **Thinking / reasoning** — `<think>` block handling and emission
- **Multi-account sessions** — Playwright-backed per-account browser contexts with automatic rotation
- **Session autoscaling** — concurrent Playwright sessions spun up under load
- **Streaming SSE** — incremental delta emission, heartbeat keep-alive, and content-filter integrity across stream boundaries
- **Content filter** — strips tool-call artifacts, streaming JSON fragment leaks, and XML leaks while preserving code whitespace
- **Token estimation** — context window validation with accurate token counting
- **Rate limiting** — per-account request tracking
- **Live debug dashboard** — `/log` shows raw vs processed output, per-chunk inspection, SSE live updates, and folded sections

## Quick Start

```bash
git clone https://github.com/youssefvdel/qwen-gate.git
cd qwen-gate
npm install
npx playwright install chromium
cp .env.example .env
npm start     # Starts on http://localhost:26405
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
  │  Session     │   Per-account Playwright browser contexts
  │   Manager    │   Autoscaling + rotation
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

## CLI

```bash
# Show help
npm run qg -- --help

# Login (opens browser for auth)
npm run qg:login

# Restart server
npm run qg:restart
```

## Docker

```bash
docker compose up --build
```

## Graphify Integration

[Graphify](https://github.com/youssefvdel/graphify) converts code, docs, and project content into a knowledge graph for semantic queries and cross-file relationship analysis. Use qwen-gate as the LLM backend for graph extraction and queries.

### Setup

1. **Configure environment**:

   ```bash
   cp .env.graphify .env
   ```

2. **Set required variables**:

   ```bash
   OPENAI_API_KEY=your_key_here
   GRAPHIFY_OPENAI_BASE_URL=http://localhost:26405/v1
   GRAPHIFY_OPENAI_MODEL=qwen3.7-max
   GRAPHIFY_TIMEOUT=120000
   ```

### Usage

```bash
# Extract knowledge graph from codebase
graphify extract .

# Update graph after code changes
graphify update .

# Query the graph
graphify query "<question>"

# Find relationships between files
graphify path "<file-a>" "<file-b>"

# Explain a concept
graphify explain "<concept>"
```

### Environment Variables

| Variable                   | Required | Description                                      |
| -------------------------- | -------- | ------------------------------------------------ |
| `OPENAI_API_KEY`           | Yes      | API key for authentication                       |
| `GRAPHIFY_OPENAI_BASE_URL` | Yes      | qwen-gate endpoint (http://localhost:26405/v1)   |
| `GRAPHIFY_OPENAI_MODEL`    | No       | Qwen model for embeddings (default: qwen3.7-max) |
| `GRAPHIFY_TIMEOUT`         | No       | Request timeout in milliseconds (default: 30000) |

### Output

Graph data is stored in `graphify-out/`:

- `graph.json` — full knowledge graph
- `GRAPH_REPORT.md` — architecture overview
- `wiki/index.md` — navigation index (if generated)

## License

[MIT](./LICENSE)
