# Security Audit Report

## Critical

### C1. Plaintext Passwords in `accounts.json`
- **File**: `src/services/accountManager.ts:143-152`
- **Issue**: Passwords only encrypted if `API_KEY` is set. With no API_KEY, passwords stored in plaintext
- **Severity**: Critical
- **Fix**: Always derive encryption key (machine ID or generated on first run)

### C2. No Authentication on Dashboard Admin Endpoints
- **File**: `src/routes/dashboard/dashboardRoutes.ts:300-301`
- **Issue**: `/admin/accounts/reload` and `/dashboard/accounts/delete-all-chats` have no auth
- **Severity**: Critical
- **Fix**: Add bearer auth middleware

### C3. SSE Stream Leaks Unsanitized Data
- **File**: `src/routes/dashboard/dashboardRoutes.ts:195-197`
- **Issue**: `/log/stream` sends raw log entries without `sanitizeLogEntry()`
- **Impact**: Full emails, prompts, API output visible in DevTools
- **Severity**: Critical

## High

### H1. `/api/config` Exposes All Config Including API_KEY
- **File**: `src/routes/dashboard/dashboardRoutes.ts:313-315`
- **Fix**: Filter sensitive keys from response

### H2. `escHtml()` Missing `'` and `` ` `` Escaping
- **File**: `src/routes/dashboard/public/shared.js:2-5`
- **Potential XSS** in single-quoted attribute contexts

### H3. `shell: true` in CLI spawn()
- **File**: `src/cli.ts:69-72,83,89,119`
- **Impact**: Command injection risk if user-controlled args enter spawn

### H4. `APP_VERSION` Interpolated Without JSON Encoding
- **File**: `src/routes/dashboard/dashboardRoutes.ts:28`
- **Fix**: Use `JSON.stringify(APP_VERSION)`

### H5. `--port` Value Interpolated Into Shell Command
- **File**: `src/cli.ts:69-72` + `src/cli.ts:56-61`
- **Fix**: Validate port is numeric before passing to spawn

## Medium

### M1. No Content-Security-Policy Headers
- **File**: `src/routes/dashboard/dashboardRoutes.ts`
- **Fix**: Add CSP to all HTML responses

### M2. No Rate Limiting on Login Endpoint
- **File**: `src/routes/accounts.ts:34-74`
- **Fix**: The existing `accountActionRateLimit` only applies to accounts API, not login attempts

### M3. Token in SSE Query Parameter
- **File**: `src/utils/auth.ts:41`
- **Issue**: `?token=` in URL is logged by proxies, browsers, server access logs
- **Fix**: Prefer `Authorization` header only

### M4. Verbose Error Messages Leak Internal Info
- **File**: Multiple — `src/services/qwen.ts`, `src/routes/chat.ts`
- **Validation**: `chat.ts:253` error messages pass through `cleanTextOfXmlArtifacts()` — some sanitization exists. `qwen.ts` custom errors (`RetryableQwenStreamError`, `UpstreamStatusError`) leak upstream error codes and statuses. Partially true — risk exists but less severe than stated.
- **Fix**: Sanitize error messages before returning to client

### M5. Missing Input Validation on `body.model`
- **File**: `src/routes/chatHelpers.ts:54,219,236`
- **Fix**: Add runtime type check

## Low

### L1. No `X-Frame-Options` or Other Security Headers
- **Fix**: Add helmet-like middleware or set headers manually

### L2. `axios`-style `shell: true` in CLI
- **Fix**: Remove `shell: true`, use `spawn` with args array only

### L3. No `.env.example` for Secret Documentation
- Fix: Create one

### L4. Hardcoded `mos3adadel@123` Password in accounts.json
- **[UNVERIFIABLE]**: This is in the user's local `accounts.json` file, not in the repository. Cannot be verified via source code analysis.
