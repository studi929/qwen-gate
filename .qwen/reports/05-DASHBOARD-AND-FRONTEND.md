# Dashboard & Frontend — Bug Report

## Critical

### F1. `loadMore()` Function Does Not Exist
- **File**: `src/routes/dashboard/logs.ts:72` + `src/routes/dashboard/public/logs.js`
- **Issue**: HTML renders "Load More" button with `onclick="loadMore()"`, but function is never defined
- **Impact**: Clicking "Load More" throws `ReferenceError`. Feature is completely broken.

### F2. SSE Stream Leaks Unsanitized Log Data
- **File**: `src/routes/dashboard/dashboardRoutes.ts:195-197`
- **Issue**: `/log/stream` SSE endpoint sends raw log entries WITHOUT calling `sanitizeLogEntry()`
- **Impact**: Full email addresses, raw prompt content, processed output streamed in plaintext to browser
- **Fix**: Apply `sanitizeLogEntry()` on SSE stream too

## High

### F3. `escHtml()` Missing Single Quote and Backtick
- **File**: `src/routes/dashboard/public/shared.js:2-5`
- **Issue**: Only escapes `&`, `<`, `>`, `"` — misses `'` and `` ` ``
- **Impact**: Potential XSS in single-quoted attribute contexts

### F4. Notification Logic Shows Wrong Entries
- **File**: `src/routes/dashboard/public/overview.js:113-114`
- **Issue**: `data.slice(0, data.length - _lastLogCount)` takes OLD entries instead of NEW entries
- **Impact**: Notifications fire for stale entries every refresh cycle

### F5. `/api/config` Exposes API_KEY
- **File**: `src/routes/dashboard/dashboardRoutes.ts:313-315`
- **Issue**: Returns ALL config including `API_KEY`
- **Fix**: Filter out sensitive keys

### F6. `authHeaders()` Always Returns `{}`
- **File**: `src/routes/dashboard/public/shared.js:10-12`
- **Issue**: Dead function that always returns empty object
- **Fix**: Remove or implement actual auth

## Medium

### F7. Full Email in Delete-Chat SSE Progress
- **File**: `src/routes/dashboard/dashboardRoutes.ts:83-91`
- **Fix**: Mask email in progress events

### F8. `APP_VERSION` Interpolated Without JSON Encoding
- **File**: `src/routes/dashboard/dashboardRoutes.ts:28`
- **Issue**: `'${APP_VERSION}'` in single-quoted JS string — breaks if version contains `'`
- **Fix**: Use `JSON.stringify(APP_VERSION)`

### F9. `pollAuth` Not Cancel-Safe
- **File**: `src/routes/dashboard/public/accounts.js:186-204`
- **Issue**: Multiple `pollAuth` for same email can stack intervals
- **Fix**: Cancel previous poll before starting new one

### F10. No Max-Count Limit on Toasts
- **File**: `src/routes/dashboard/public/accounts.js:9`, `overview.js:125`, `settings.js:261`
- **Fix**: Limit to 3-5 visible toasts, remove oldest

### F11. Full DOM Rebuild Every 2s for System Logs
- **File**: `src/routes/dashboard/public/overview.js:90-124`
- **Issue**: Entire `innerHTML` replaced every 2 seconds
- **Fix**: Only append new entries

### F12. Redundant `durationClass` Condition
- **File**: `src/routes/dashboard/public/network.js:40-43`
- **Issue**: `ms > 3000` and `ms > 500` both return `'slow'`
- **Fix**: Remove redundant first condition

## Low

### F13. Missing `aria-label`, `scope`, `<label for>` Throughout
- Accessibility improvements needed across all pages

### F14. No Content-Security-Policy Headers
- **File**: `src/routes/dashboard/dashboardRoutes.ts:27-31`
- **Fix**: Add CSP headers to `serveHtml`

### F15. Color Contrast Fails WCAG AA
- **File**: `src/routes/dashboard/public/overview.css:44`
- **Issue**: Log level colors (indigo, amber, red) on cream background fail contrast requirements

### F16. Excessive Polling With No Backoff
- All pages poll at 2-second intervals, no Page Visibility API pause
- **Fix**: Add backoff, pause when tab is backgrounded
