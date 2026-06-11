# Deployment & DevOps — Analysis

## Critical

### D1. No Docker Support
- Issue #40 requested this
- **Fix**: Create Dockerfile with:
  1. `node:22-alpine` base
  2. `RUN npx playwright install chromium`
  3. `COPY .qwen/` for persistent data
  4. `ENV QWEN_GATE_PORT=26405`

## High

### D2. No Production Startup Script
- `npm start` runs `tsx` (dev runner), not compiled JS
- `tsconfig.build.json` exists but is never used by any script
- `bin/qg` prefers `npx tsx` over compiled output
- **Fix**: Add `npm run build && node dist/index.js` as production start

### D3. `--host` CLI Flag Parsed But Ignored
- `src/cli.ts:56` parses `--host` but `src/index.tsx:187-195` never passes it to `serve()`
- **Fix**: Add `host` to `serve()` options

### D4. `config.json` Keys Silently Ignored
- `config.json` has keys (`HOST`, `DASHBOARD`, `STREAMING`, etc.) NOT in `ConfigSchema`
- Users edit these values with no feedback they're ignored
- **Fix**: Either support them in ConfigSchema or remove from config.json

### D5. `restart` Kills ALL Matching Processes
- Unix: `pkill -f "tsx.*index.ts"` kills any matching process
- Windows: `taskkill /F /IM node.exe` kills ALL node processes
- **Fix**: Use PID file for targeted process management

### D6. No Config Validation at Startup
- Bad JSON silently falls back to empty config
- Invalid `PORT: "abc"` silently uses default 26405
- **Fix**: Add validation layer that logs warnings

## Medium

### D7. Port Conflict Causes Crash
- No try/catch around `serve()` — if port is taken, process exits
- **Fix**: Retry with `port + 1` or log clear error

### D8. No Environment-Specific Config
- No `NODE_ENV` usage anywhere in code
- **Fix**: Add dev/prod profile loading

### D9. `tsx` as Runtime Dependency (~100MB)
- `tsx` in dependencies (not devDependencies) inflates production install
- `esbuild` binaries for all platforms downloaded
- **Fix**: Compile TypeScript, run with plain `node`

### D10. No `dotenv` Support
- Config reads `process.env` directly but never loads `.env` file
- **Fix**: Add `import 'dotenv/config'` or `dotenv.config()`

### D11. Command Parsing Edge Case Bug
- `qg --port 8080` treats `'8080'` as the command
- **Fix**: Filter out known flag values before command detection

### D12. `bin/qg` Is Bash-Only
- Won't work on Windows without WSL
- **Fix**: Create native `.ps1` or `.cmd` wrapper

## Low

### D13. No `--version` Flag
- `APP_VERSION` exists but not exposed via CLI
- **Fix**: Add `--version` handler

### D14. No `.env.example`
- `.env` is gitignored but no template exists
- **Fix**: Create from ConfigSchema keys

### D15. No Compression Middleware
- JSON responses sent uncompressed
- **Fix**: Add `hono/compress`

### D16. Health Check Is Fragile
- Only checks if Playwright page reference is non-null
- **Fix**: Add account readiness, Qwen connectivity checks
