# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-06-14

### Fixed
- **Stream Idle Timeout Hang**: Upstream silence no longer hangs the client indefinitely. Catches timeout gracefully, writes error SSE event + `[DONE]`, logs to dashboard. Default timeout 45s, configurable via `STREAM_IDLE_TIMEOUT_MS`.
- **Tool Call Content Leak**: Streaming tool call XML fragments (`<function=`, `=filePath>`, `-edit`) no longer leak into emitted content. Uses `toolCallDepth` state counter + per-chunk detection.
- **Timing-Safe API Key**: Config route now uses constant-time comparison (`safeCompare`) for API key check.

### Changed
- **Data-Driven Stripping**: All tag names centralized in `src/utils/tagNames.ts`. `TOOL_CALL_KEYWORDS`, `THINK_TAG_NAMES`, `TOOL_RESULT_KEYWORDS` arrays drive regex construction in all 8 stripping sites. No hardcoded regex patterns.
- **Deduplication**: Think tag regex consolidated from 5 sites → 1 shared. Newline normalization unified to `\n{3,}→\n\n` everywhere. Removed 250+ lines of dead code (`json.ts`, `stripStreamingDelta`, `repairMalformedJson`, unused re-exports).
- **Performance**: `END_TAG_PATTERNS` hoisted to module-level. `IDLE_TIMEOUT_MS` hoisted out of hot loop. Short-circuit guards added to `cleanThinkTags` and `parseXmlToolCalls`.
- **Better Diagnostics**: JSON parse errors log raw data. Stream errors captured in both console and dashboard log.

### Fixed
- **Dashboard Script Injection**: Fixed critical bug where `serveHtml` broke all `<script src="...">` tags when injecting `window.APP_VERSION`. ([#5](https://github.com/youssefvdel/qwen-gate/issues/5))

## [0.2.0] - 2026-06-04

### Added
- **Dashboard Web Interface**: Complete vanilla HTML/JS dashboard with 5 pages (overview, logs, accounts, network, settings)
- **Claymorphism Design**: Warm cream/beige color palette with sage green accents (#F5F1EA bg, #5E9D5C accent)
- **Unified Sidebar Navigation**: Consistent navigation across all dashboard pages
- **12-Hour Time Format**: All timestamps now display in 12-hour AM/PM format
- **100% Width Layout**: Dashboard pages use full available width
- **CLI Tool `qg`**: Command-line interface for account management (login, list, remove)
- **One-Command Install Script**: `curl -sSL https://raw.githubusercontent.com/youssefvdel/qwen-gate/main/install.sh | bash`
- **Network Debug Page**: View outbound API calls with expandable detail panels
- **System Logs Panel**: Real-time system logs in overview dashboard
- **Session Pool Dashboard**: Live session utilization bar and model health table

### Changed
- **Dashboard Architecture**: Replaced Astro+SolidJS with vanilla HTML/JS (no build step)
- **Browser Automation**: Migrated from Playwright to CloakBrowser for enhanced stealth
- **Dashboard Styling**: Applied Claymorphism design with soft shadows, 16px border radius, and Poppins typography
- **Log Entry Layout**: Two-column grid (70/30 split) with Raw/Processed Output side-by-side
- **Chunk Stream**: Fills 100% height with internal scroll, unfolds by default
- **Network Page**: Fixed JavaScript syntax errors (template literal escaping, `\n` → `\\n`)

### Fixed
- **Thinking Emission Leak**: Deferred thinking emission until after echo detection completes
- **Token Waste**: Abort upstream requests immediately on echo detection
- **Streaming Delta Ordering**: Fixed pattern ordering (B→C→A→D→E) with negative lookbehind
- **Marker Leakage**: Prevented `[READ TOOL RESULT]` marker from appearing in user output
- **Tool Result Echo Filter**: Integrated filter in streaming delta loop
- **API Key Injection**: Fixed template literal escape sequences in network page (`\'` → `"'"`)
- **Browser Profile Tracking**: Added `.gitignore` rules to exclude runtime browser profiles

## [0.1.0] - 2026-05-28

### Added
- **OpenAI-Compatible API Gateway**: Full `/v1/chat/completions` and `/v1/models` endpoints
- **Multi-Account Session Management**: Browser-based authentication with automatic session rotation
- **Streaming Support**: Server-Sent Events (SSE) for real-time chat responses
- **Tool Calling**: Complete OpenAI tool calling protocol with parallel tool execution
- **Echo Detection**: Intelligent detection and filtering of model echo patterns
- **Content Filter Pipeline**: Pluggable filter system for request/response transformation
- **Session Pool**: Pre-authenticated browser session management with automatic refresh
- **Logging System**: Structured JSON logging with request/response capture
- **Account Management**: Add/remove/list accounts via API and CLI
- **Configuration System**: Environment variables, config.json, and runtime config API

### Changed
- **Browser Stealth**: Enhanced anti-detection measures for browser automation
- **Session Refresh**: Improved session TTL management and automatic refresh logic
- **Error Handling**: Structured OpenAI-compatible error responses
- **Rate Limiting**: Per-account rate limiting with automatic cooldown

### Fixed
- **Session Expiry**: Automatic session refresh before expiration
- **Tool Result Parsing**: Fixed edge cases in tool result JSON parsing
- **Stream Interruption**: Graceful handling of upstream stream interruptions
- **Account Rotation**: Fixed round-robin account selection under high load

## [0.0.1] - 2026-05-15

### Added
- Initial project structure
- Basic Hono web server setup
- TypeScript configuration
- Package.json with core dependencies
- Basic README with project description

[0.5.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.4.0...v0.5.0
[0.2.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/youssefvdel/qwen-gate/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/youssefvdel/qwen-gate/releases/tag/v0.0.1
