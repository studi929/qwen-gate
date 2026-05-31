/*
 * File: logPage.ts
 * Professional monitoring dashboard — auto-updates via SSE and polling
 */

export const logHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — Monitoring</title>
<style>
:root {
  --bg-primary: #0a0a0f;
  --bg-card: #12121a;
  --bg-elevated: #1a1a25;
  --border: #2a2a35;
  --text-primary: #e4e4e7;
  --text-secondary: #71717a;
  --accent: #6366f1;
  --accent-soft: rgba(99,102,241,0.15);
  --success: #22c55e;
  --success-soft: rgba(34,197,94,0.15);
  --warning: #f59e0b;
  --warning-soft: rgba(245,158,11,0.15);
  --danger: #ef4444;
  --danger-soft: rgba(239,68,68,0.15);
  --radius: 12px;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --mono: 'SF Mono', Monaco, Consolas, monospace;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);line-height:1.5;min-height:100vh}

/* Layout */
.dashboard{max-width:100%;margin:0 auto;padding:20px}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px}
.header-left{display:flex;align-items:center;gap:12px}
.header h1{font-size:1.125rem;font-weight:600;color:var(--text-primary);letter-spacing:-0.01em}
.live-indicator{display:flex;align-items:center;gap:6px;font-size:0.75rem;color:var(--success);text-transform:uppercase;letter-spacing:0.05em;font-weight:500}
.live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.85)}}

.dashboard-grid{display:grid;grid-template-columns:2fr 1fr;gap:16px;align-items:start}
.log-main{display:flex;flex-direction:column;gap:16px}
.right-sidebar{display:flex;flex-direction:column;gap:16px}
.req-entry{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:8px;animation:fadeIn 0.3s ease}

.header-meta{font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}

/* KPI Grid */
.kpi-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.kpi-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:4px;transition:border-color 0.2s}
.kpi-card:hover{border-color:var(--accent)}
.kpi-label{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500}
.kpi-value{font-size:2rem;font-weight:700;line-height:1.1;color:var(--text-primary);font-variant-numeric:tabular-nums}
.kpi-sub{font-size:0.75rem;color:var(--text-secondary);font-family:var(--mono)}

.panel-full{grid-column:1/-1}

/* Panel */
.panel{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;cursor:pointer;user-select:none;border-bottom:1px solid transparent;transition:background 0.15s}
.panel-header:hover{background:var(--bg-elevated)}
.panel-header.open{border-bottom-color:var(--border)}
.panel-title{font-size:0.875rem;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:8px}
.panel-title svg{width:14px;height:14px;opacity:0.7}
.panel-chevron{width:16px;height:16px;color:var(--text-secondary);transition:transform 0.25s ease}
.panel-header.open .panel-chevron{transform:rotate(180deg)}
.panel-body{max-height:0;overflow:hidden;transition:max-height 0.35s ease}
.panel-body.open{max-height:99999px}
.panel-content{padding:0 16px 16px}

/* Tables */
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:0.8125rem}
thead th{text-align:left;padding:10px 8px;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;border-bottom:1px solid var(--border);white-space:nowrap}
tbody td{padding:10px 8px;border-bottom:1px solid var(--border);color:var(--text-primary);vertical-align:middle;word-break:break-all}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:var(--bg-elevated)}

/* Badges */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:9999px;font-size:0.7rem;font-weight:500;white-space:nowrap;gap:4px}
.badge-success{background:var(--success-soft);color:var(--success)}
.badge-danger{background:var(--danger-soft);color:var(--danger)}
.badge-warning{background:var(--warning-soft);color:var(--warning)}
.badge-accent{background:var(--accent-soft);color:var(--accent)}
.badge-neutral{background:var(--bg-elevated);color:var(--text-secondary)}
.account-badge{background:var(--accent-soft);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent)}

/* Account Management */
.account-mgmt-form{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.account-mgmt-input{flex:1;min-width:150px;padding:8px 12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:0.8125rem}
.account-mgmt-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.account-mgmt-btn{padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);font-size:0.8125rem;font-weight:500;cursor:pointer;transition:opacity 0.2s}
.account-mgmt-btn:hover{opacity:0.9}
.account-mgmt-btn.danger{background:var(--danger)}
.account-mgmt-btn.success{background:var(--success)}
.account-mgmt-btn.small{padding:4px 8px;font-size:0.75rem}
.account-mgmt-actions{display:flex;gap:6px}
.account-auth-status{display:flex;align-items:center;gap:6px}
.account-auth-dot{width:8px;height:8px;border-radius:50%}
.account-auth-dot.authenticated{background:var(--success)}
.account-auth-dot.not-authenticated{background:var(--danger)}
.account-mgmt-error{background:var(--danger-soft);color:var(--danger);padding:8px 12px;border-radius:var(--radius);font-size:0.8125rem;margin-bottom:12px;display:none}
.account-mgmt-toast{position:fixed;bottom:20px;right:20px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:1000;animation:slideIn 0.3s ease}
.account-mgmt-toast.success{border-left:3px solid var(--success)}
.account-mgmt-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;align-items:center;justify-content:center}
.account-mgmt-modal{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:24px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
.account-mgmt-modal h3{margin:0 0 8px;font-size:1rem}
.account-mgmt-modal p{margin:0 0 20px;font-size:0.875rem;color:var(--text-secondary)}
.account-mgmt-modal-actions{display:flex;gap:8px;justify-content:flex-end}
.account-mgmt-modal-actions button{padding:8px 20px;border:none;border-radius:var(--radius);font-size:0.8125rem;cursor:pointer;font-weight:500}
.account-mgmt-modal-cancel{background:var(--bg-base);color:var(--text-primary);border:1px solid var(--border)!important}
.account-mgmt-modal-confirm{background:var(--danger);color:#fff}
.account-mgmt-toast.error{border-left:3px solid var(--danger)}
.account-mgmt-toast.warning{border-left:3px solid var(--warning)}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}

/* Session Pool Visual */
.pool-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding-top:8px}
.pool-stat{text-align:center;padding:12px;background:var(--bg-elevated);border-radius:8px}
.pool-stat-value{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums}
.pool-stat-label{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin-top:2px}
.pool-bar{height:4px;background:var(--bg-elevated);border-radius:2px;margin-top:12px;overflow:hidden}
.pool-bar-fill{height:100%;border-radius:2px;transition:width 0.5s ease}

/* System Logs */
.sys-log-entry{display:flex;gap:10px;padding:6px 0;font-family:var(--mono);font-size:0.75rem;border-bottom:1px solid var(--border);align-items:flex-start}
.sys-log-entry:last-child{border-bottom:none}
.sys-log-ts{color:var(--text-secondary);white-space:nowrap;flex-shrink:0}
.sys-log-level{font-weight:600;width:44px;flex-shrink:0;text-transform:uppercase;font-size:0.65rem;padding-top:1px}
.sys-log-cat{color:var(--accent);white-space:nowrap;flex-shrink:0;min-width:80px}
.sys-log-msg{color:var(--text-primary);word-break:break-all}
.log-debug{color:#71717a}.log-info{color:#6366f1}.log-warn{color:#f59e0b}.log-error{color:#ef4444}

/* Request Log / SSE Stream */
#requestLogContainer{overflow-y:visible}
.req-entry{border-bottom:1px solid var(--border);animation:fadeIn 0.3s ease}
.req-entry:last-child{border-bottom:none}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.req-header{display:flex;align-items:center;gap:8px;padding:10px 0;flex-wrap:wrap}
.req-ts{font-family:var(--mono);font-size:0.7rem;color:var(--text-secondary);flex-shrink:0}
.req-model{font-size:0.75rem;font-weight:500}
.req-status{font-size:0.7rem;font-family:var(--mono)}
.req-detail{padding:0 0 12px 0}
.req-section-label{font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin:8px 0 4px;font-weight:500}
.req-entry{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px}
.req-block{background:var(--bg-elevated);border-radius:8px;padding:10px 12px;font-family:var(--mono);font-size:0.7rem;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--text-primary)}
.req-block pre{margin:0;white-space:pre-wrap;word-break:break-all;font-family:var(--mono);font-size:0.7rem;line-height:1.6;color:var(--text-primary)}
.load-more-btn{display:block;width:100%;padding:10px;margin:8px 0;background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);border-radius:8px;cursor:pointer;font-size:0.8125rem;font-weight:500;text-align:center;transition:all 0.2s}
.load-more-btn:hover{background:var(--accent);color:var(--text-primary)}
.load-more-btn:disabled{opacity:0.5;cursor:not-allowed}
/* Per-message foldable content */
.msg-header{cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:4px;padding:2px 0}
.msg-header .fold-toggle{display:inline-block;transition:transform .2s;font-size:7px;margin-right:2px}
.msg-header.collapsed .fold-toggle{transform:rotate(0deg)}
.msg-header:not(.collapsed) .fold-toggle{transform:rotate(90deg)}
.msg-body.collapsed{display:none}
.msg-body:not(.collapsed){max-height:250px;overflow-y:auto}

/* Foldable sections */
.foldable-section{border:1px solid var(--border);border-radius:6px;margin:6px 0;overflow:hidden}
.foldable-header{cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;background:var(--bg-elevated)}
.foldable-header:hover{color:var(--text-primary)}
.fold-toggle{display:inline-block;transition:transform .2s;font-size:9px}
.foldable-header.collapsed .fold-toggle{transform:rotate(0deg)}
.foldable-header:not(.collapsed) .fold-toggle{transform:rotate(90deg)}
.foldable-body.collapsed{display:none}
.foldable-body:not(.collapsed){padding:4px 8px}

/* Empty State */
.empty-state{padding:32px 16px;text-align:center;color:var(--text-secondary);font-size:0.8125rem}
.empty-state svg{width:32px;height:32px;margin-bottom:8px;opacity:0.3}

/* Responsive */
@media(max-width:1200px){.dashboard-grid{grid-template-columns:1fr 1fr}.kpi-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){.dashboard-grid{grid-template-columns:1fr}.kpi-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:600px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.pool-grid{grid-template-columns:repeat(2,1fr)}.dashboard{padding:12px}}
</style>
</head>
<body>
<div class="dashboard">
  <div class="header">
    <div class="header-left">
      <h1>Qwen Gate</h1>
      <div class="live-indicator"><span class="live-dot"></span>Live</div>
    </div>
    <div class="header-meta" id="uptimeDisplay">—</div>
  </div>

  <div class="dashboard-grid">
    <!-- Left: Request Log (main focus) -->
    <div class="log-main">
      <div class="panel">
        <div class="panel-header open" onclick="togglePanel(this)">
          <span>Request Log</span>
          <span class="panel-toggle">▼</span>
        </div>
        <div class="panel-body open">
          <div class="panel-content" id="requestLogContainer">
            <div class="empty-state" id="requestLogEmpty">Waiting for requests…</div>
          </div>
        </div>
      </div>
    </div>
    <!-- Right Sidebar: Everything else -->
    <div class="right-sidebar">
      <div class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-label">Total Accounts</span>
          <span class="kpi-value" id="kpiTotalAccounts">—</span>
          <span class="kpi-sub" id="kpiTotalAccountsSub">&nbsp;</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Available</span>
          <span class="kpi-value" id="kpiAvailable">—</span>
          <span class="kpi-sub" id="kpiAvailableSub">&nbsp;</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Active Sessions</span>
          <span class="kpi-value" id="kpiActiveSessions">—</span>
          <span class="kpi-sub" id="kpiActiveSessionsSub">&nbsp;</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Queue</span>
          <span class="kpi-value" id="kpiQueue">—</span>
          <span class="kpi-sub" id="kpiQueueSub">&nbsp;</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Total Requests</span>
          <span class="kpi-value" id="kpiTotalRequests">—</span>
          <span class="kpi-sub" id="kpiTotalRequestsSub">&nbsp;</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Uptime</span>
          <span class="kpi-value" id="kpiUptime">—</span>
          <span class="kpi-sub" id="kpiUptimeSub">&nbsp;</span>
        </div>
      </div>
      <!-- Accounts Panel -->
      <div class="panel">
        <div class="panel-header" onclick="togglePanel(this)">
          <span>Accounts</span>
          <span class="panel-toggle">▼</span>
        </div>
        <div class="panel-body open">
          <div class="panel-content">
            <table id="accountsTable">
              <thead><tr><th>Email</th><th>Auth</th><th>In Flight</th><th>Total Reqs</th><th>Throttle</th><th>Token TTL</th></tr></thead>
              <tbody id="accountsBody"></tbody>
            </table>
            <div class="empty-state" id="accountsEmpty" style="display:none">No accounts registered</div>
          </div>
        </div>
      </div>
      <!-- Account Management -->
      <div class="panel">
        <div class="panel-header" onclick="togglePanel(this)">
          <span>Account Management</span>
          <span class="panel-toggle">▼</span>
        </div>
        <div class="panel-body open">
          <div class="panel-content">
            <div class="account-mgmt-error" id="accountMgmtError"></div>
            <form class="account-mgmt-form" id="accountMgmtForm">
              <input type="email" class="account-mgmt-input" id="accountEmailInput" placeholder="Email" required>
              <input type="password" class="account-mgmt-input" id="accountPasswordInput" placeholder="Password" required>
              <button type="submit" class="account-mgmt-btn">Add Account</button>
            </form>
            <div class="tbl-wrap">
              <table id="accountMgmtTable">
                <thead><tr><th>Email</th><th>Auth Status</th><th>Actions</th></tr></thead>
                <tbody id="accountMgmtBody"></tbody>
              </table>
            </div>
            <div class="empty-state" id="accountMgmtEmpty" style="display:none">No accounts registered</div>
          </div>
        </div>
      </div>
      <div id="accountMgmtConfirmOverlay" class="account-mgmt-overlay">
        <div class="account-mgmt-modal">
          <h3>Remove Account</h3>
          <p>Are you sure you want to remove <strong id="accountMgmtConfirmEmail"></strong>?</p>
          <div class="account-mgmt-modal-actions">
            <button id="accountMgmtConfirmNo" class="account-mgmt-modal-cancel">Cancel</button>
            <button id="accountMgmtConfirmYes" class="account-mgmt-modal-confirm">Remove</button>
          </div>
        </div>
      </div>
      <!-- Session Pool -->
      <div class="panel">
        <div class="panel-header" onclick="togglePanel(this)">
          <span>Session Pool</span>
          <span class="panel-toggle">▼</span>
        </div>
        <div class="panel-body open">
          <div class="panel-content">
            <div class="pool-grid" id="poolGrid">
              <div class="pool-stat"><div class="pool-stat-value" id="poolActive">—</div><div class="pool-stat-label">Active</div></div>
              <div class="pool-stat"><div class="pool-stat-value" id="poolWaiting">—</div><div class="pool-stat-label">Waiting</div></div>
              <div class="pool-stat"><div class="pool-stat-value" id="poolAvailable">—</div><div class="pool-stat-label">Available</div></div>
              <div class="pool-stat"><div class="pool-stat-value" id="poolTotal">—</div><div class="pool-stat-label">Total</div></div>
            </div>
            <div class="pool-bar"><div class="pool-bar-fill" id="poolBarFill" style="width:0%"></div></div>
            <div class="empty-state" id="poolEmpty" style="display:none">No pool data available</div>
          </div>
        </div>
      </div>
      <!-- Model Health -->
      <div class="panel">
        <div class="panel-header" onclick="togglePanel(this)">
          <span>Model Health</span>
          <span class="panel-toggle">▼</span>
        </div>
        <div class="panel-body open">
          <div class="panel-content">
            <table id="modelTable">
              <thead><tr><th>Model</th><th>Success</th><th>Errors</th><th>Rate</th><th>Last Activity</th></tr></thead>
              <tbody id="modelBody"></tbody>
            </table>
            <div class="empty-state" id="modelEmpty" style="display:none">No model activity recorded</div>
          </div>
        </div>
      </div>
      <!-- System Logs -->
      <div class="panel">
        <div class="panel-header" onclick="togglePanel(this)">
          <span>System Logs</span>
          <span class="panel-toggle">▼</span>
        </div>
        <div class="panel-body open">
          <div class="panel-content" id="sysLogsContainer">
            <div class="empty-state" id="sysLogsEmpty">No system logs yet</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
function authHeaders() {
  if (!window.API_KEY) return {};
  return { 'Authorization': 'Bearer ' + window.API_KEY };
}
function authUrl(path) {
  if (!window.API_KEY) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + window.API_KEY;
}

/* ── Helpers ── */
function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  var s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  s %= 60; m %= 60; h %= 24;
  var parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (parts.length === 0) parts.push(s + 's');
  return parts.join(' ');
}
function fmtTTL(ms) {
  if (ms == null || ms < 0) return '—';
  var m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  m %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
function fmtTime(ts) {
  if (!ts) return '—';
  var d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toTimeString().slice(0, 8);
}
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtJson(raw) {
  if (!raw) return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch(e) { return raw; }
}
function togglePanel(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  body.classList.toggle('open');
}
function toggleFold(header) {
  header.classList.toggle('collapsed');
  var body = header.nextElementSibling;
  body.classList.toggle('collapsed');
}

/* ── State ── */
var MAX_REQUEST_ENTRIES = 10;
var RENDER_LIMIT_INITIAL = 50; // Show 50 entries initially
var renderLimit = RENDER_LIMIT_INITIAL;
var requestEntries = [];
var requestEntryMap = {};

/* ── Fetch wrapper ── */
async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

/* ── KPI + Health ── */
async function refreshHealth() {
  var data = await apiFetch('/health');
  if (!data) return;
  var accts = data.accounts || {};
  setText('kpiTotalAccounts', accts.total != null ? accts.total : '—');
  setText('kpiAvailable', accts.available != null ? accts.available : '—');
  setText('uptimeDisplay', data.status === 'ok' ? 'Operational' : data.status || '—');
  var availPct = accts.total > 0 ? Math.round((accts.available / accts.total) * 100) : 0;
  setText('kpiAvailableSub', availPct + '% of total');
}

/* ── Accounts ── */
async function refreshAccounts() {
  var data = await apiFetch('/accounts');
  var tbody = document.getElementById('accountsBody');
  var empty = document.getElementById('accountsEmpty');
  var table = document.getElementById('accountsTable');
  if (!data || !Array.isArray(data) || data.length === 0) {
    table.style.display = 'none';
    empty.style.display = '';
    setText('kpiTotalRequests', '0');
    return;
  }
  table.style.display = '';
  empty.style.display = 'none';
  var totalReqs = 0;
  var rows = '';
  for (var i = 0; i < data.length; i++) {
    var a = data[i];
    totalReqs += (a.totalRequests || 0);
    var authBadge = a.authenticated
      ? '<span class="badge badge-success">✓ Auth</span>'
      : '<span class="badge badge-danger">✗ No</span>';
    var throttleBadge = a.throttled
      ? '<span class="badge badge-warning">Throttled ' + fmtTTL(a.throttledRemainingMs) + '</span>'
      : '<span class="badge badge-neutral">OK</span>';
    rows += '<tr>'
      + '<td>' + escHtml(a.email) + '</td>'
      + '<td>' + authBadge + '</td>'
      + '<td>' + (a.inFlight || 0) + '</td>'
      + '<td>' + (a.totalRequests || 0) + '</td>'
      + '<td>' + throttleBadge + '</td>'
      + '<td>' + fmtTTL(a.tokenExpiresInMs) + '</td>'
      + '</tr>';
  }
  tbody.innerHTML = rows;
  setText('kpiTotalRequests', totalReqs);
}

/* ── Account Management ── */
function showToast(message, type) {
  var existing = document.querySelector('.account-mgmt-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.className = 'account-mgmt-toast ' + (type === 'success' ? 'success' : type === 'warning' ? 'warning' : 'error');
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(function() { toast.remove(); }, 3000);
}

async function renderAccountMgmt() {
  var data = await apiFetch('/accounts');
  var tbody = document.getElementById('accountMgmtBody');
  var empty = document.getElementById('accountMgmtEmpty');
  var table = document.getElementById('accountMgmtTable');
  var errorDiv = document.getElementById('accountMgmtError');
  
  if (!data || !Array.isArray(data) || data.length === 0) {
    table.style.display = 'none';
    empty.style.display = '';
    errorDiv.style.display = 'none';
    return;
  }
  
  table.style.display = '';
  empty.style.display = 'none';
  errorDiv.style.display = 'none';
  
  var rows = '';
  for (var i = 0; i < data.length; i++) {
    var a = data[i];
    var authClass = a.authenticated ? 'authenticated' : 'not-authenticated';
    var authText = a.authenticated ? 'Authenticated' : 'Not authenticated';
    var loginStyle = a.authenticated ? ' style="display:none"' : '';
    var loginLabel = a.authenticated ? '✓ Completed' : 'Login';
    rows += '<tr>'
      + '<td>' + escHtml(a.email) + '</td>'
      + '<td><div class="account-auth-status"><div class="account-auth-dot ' + authClass + '"></div>' + authText + '</div></td>'
      + '<td><div class="account-mgmt-actions">'
      + '<button class="account-mgmt-btn small danger" data-email="' + escHtml(a.email) + '" data-action="remove">Remove</button>'
      + '<button class="account-mgmt-btn small primary" data-email="' + escHtml(a.email) + '" data-action="login"' + loginStyle + '>' + loginLabel + '</button>'
      + '</div></td></tr>';
  }
  tbody.innerHTML = rows;
}

async function handleAddAccount(email, password) {
  var errorDiv = document.getElementById('accountMgmtError');
  try {
    var res = await fetch('/api/accounts', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ email: email, password: password })
    });
    var result = await res.json();
    if (!res.ok || !result.success) {
      throw new Error(result.message || 'Failed to add account');
    }
    if (result.loginSucceeded) {
      showToast('Account added and logged in: ' + email, 'success');
      pollUntilAuthenticated(email, 15);
    } else {
      showToast((result.loginError || 'Account added but login failed') + '. Click Login to open browser and log in manually.', 'warning');
      pollUntilAuthenticated(email, 15);
    }
    errorDiv.style.display = 'none';
    renderAccountMgmt();
  } catch (e) {
    errorDiv.textContent = e.message;
    errorDiv.style.display = '';
    showToast(e.message, 'error');
  }
}

async function handleRemoveAccount(email) {
  document.getElementById('accountMgmtConfirmEmail').textContent = email;
  document.getElementById('accountMgmtConfirmOverlay').style.display = 'flex';
  document.getElementById('accountMgmtConfirmYes').onclick = async function() {
    document.getElementById('accountMgmtConfirmOverlay').style.display = 'none';
    var errorDiv = document.getElementById('accountMgmtError');
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
        method: 'DELETE',
        headers: authHeaders()
      });
      var result = await res.json();
      if (!res.ok || !result.success) {
        throw new Error(result.message || 'Failed to remove account');
      }
      showToast('Account removed: ' + email, 'success');
      errorDiv.style.display = 'none';
      renderAccountMgmt();
    } catch (e) {
      errorDiv.textContent = e.message;
      errorDiv.style.display = '';
      showToast(e.message, 'error');
    }
  };
  document.getElementById('accountMgmtConfirmNo').onclick = function() {
    document.getElementById('accountMgmtConfirmOverlay').style.display = 'none';
  };
}

async function handleManualLogin(email) {
  var errorDiv = document.getElementById('accountMgmtError');
  var btn = document.querySelector('button[data-email="' + email.replace(/"/g, '&quot;') + '"][data-action="login"]');
  if (btn) { btn.textContent = 'Opening browser...'; btn.disabled = true; }
  try {
    var res = await fetch('/api/accounts/' + encodeURIComponent(email) + '/autofill', {
      method: 'GET',
      headers: authHeaders()
    });
    var result = await res.json();
    if (!res.ok || !result.success) {
      throw new Error(result.message || 'Login failed');
    }
    if (btn) { btn.textContent = 'Browser open'; btn.disabled = false; }
    showToast('Browser opened — log in manually. The session will be captured automatically.', 'warning');
    errorDiv.style.display = 'none';
    pollUntilAuthenticated(email, 30);
  } catch (e) {
    if (btn) { btn.textContent = 'Login'; btn.disabled = false; }
    errorDiv.textContent = e.message;
    errorDiv.style.display = '';
    showToast(e.message, 'error');
  }
}

function pollUntilAuthenticated(email, maxAttempts) {
  var attempt = 0;
  var timer = setInterval(async function() {
    attempt++;
    try {
      var data = await apiFetch('/accounts');
      if (!Array.isArray(data)) { clearInterval(timer); return; }
      for (var i = 0; i < data.length; i++) {
        if (data[i].email === email && data[i].authenticated) {
          clearInterval(timer);
          showToast('Login completed for ' + email, 'success');
          renderAccountMgmt();
          return;
        }
      }
    } catch (e) {
      clearInterval(timer);
    }
    if (attempt >= maxAttempts) {
      clearInterval(timer);
      renderAccountMgmt();
    }
  }, 2000);
}

/* ── Pool Stats ── */
async function refreshPool() {
  var data = await apiFetch('/pool/stats');
  var grid = document.getElementById('poolGrid');
  var empty = document.getElementById('poolEmpty');
  var bar = document.getElementById('poolBarFill');
  if (!data) {
    grid.style.display = 'none';
    if (bar) bar.parentElement.style.display = 'none';
    empty.style.display = '';
    return;
  }
  grid.style.display = '';
  bar.parentElement.style.display = '';
  empty.style.display = 'none';
  var inUse = data.inUse || 0;
  var wait = data.waiting || 0;
  var avail = data.available || 0;
  var total = data.total || 0;
  setText('poolActive', inUse);
  setText('poolWaiting', wait);
  setText('poolAvailable', avail);
  setText('poolTotal', total);
  setText('kpiActiveSessions', inUse);
  setText('kpiQueue', wait);
  var pct = total > 0 ? Math.min(100, Math.round((inUse / total) * 100)) : 0;
  bar.style.width = pct + '%';
  bar.style.background = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--accent)';
  setText('kpiQueueSub', 'of ' + total + ' sessions');
}

/* ── Model Health ── */
async function refreshModelHealth() {
  var data = await apiFetch('/metrics/model-health');
  var tbody = document.getElementById('modelBody');
  var empty = document.getElementById('modelEmpty');
  var table = document.getElementById('modelTable');
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    table.style.display = 'none';
    empty.style.display = '';
    return;
  }
  table.style.display = '';
  empty.style.display = 'none';
  var rows = '';
  var keys = Object.keys(data).sort();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], m = data[k];
    var total = (m.successCount || 0) + (m.errorCount || 0);
    var rate = total > 0 ? Math.round(((m.successCount || 0) / total) * 100) : 0;
    var rateClass = rate >= 95 ? 'badge-success' : rate >= 80 ? 'badge-warning' : 'badge-danger';
    rows += '<tr>'
      + '<td>' + escHtml(k) + '</td>'
      + '<td>' + (m.successCount || 0) + '</td>'
      + '<td>' + (m.errorCount || 0) + '</td>'
      + '<td><span class="badge ' + rateClass + '">' + rate + '%</span></td>'
      + '<td>' + fmtTime(m.lastActivity) + '</td>'
      + '</tr>';
  }
  tbody.innerHTML = rows;
}

/* ── System Logs ── */
async function refreshSysLogs() {
  var data = await apiFetch('/system/logs?limit=10');
  var container = document.getElementById('sysLogsContainer');
  var empty = document.getElementById('sysLogsEmpty');
  if (!data || !Array.isArray(data) || data.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  var html = '';
  for (var i = 0; i < data.length; i++) {
    var l = data[i];
    var lvl = (l.level || 'info').toLowerCase();
    var cls = 'log-' + (lvl === 'debug' ? 'debug' : lvl === 'warn' || lvl === 'warning' ? 'warn' : lvl === 'error' ? 'error' : 'info');
    html += '<div class="sys-log-entry">'
      + '<span class="sys-log-ts">' + fmtTime(l.timestamp) + '</span>'
      + '<span class="sys-log-level ' + cls + '">' + escHtml(lvl) + '</span>'
      + '<span class="sys-log-cat">' + escHtml(l.category || '') + '</span>'
      + '<span class="sys-log-msg">' + escHtml(l.message || '') + '</span>'
      + '</div>';
  }
  /* preserve empty state element */
  container.innerHTML = html;
  container.appendChild(empty);
}

/* ── SSE Request Log ── */
function connectSSE() {
  var es = new EventSource(authUrl('/log/stream'));
  es.onmessage = function(ev) {
    try {
      var entry = JSON.parse(ev.data);
      addRequestEntry(entry);
    } catch(e) {console.error('SSE parse error', e)}
  };
  es.onerror = function() {
    es.close();
    setTimeout(connectSSE, 3000);
  };
}
function renderEntryHtml(entry) {
  var model = entry.model || 'unknown';
  var stream = entry.stream !== false;
  var hasError = entry.errors && entry.errors.length > 0;
  var isDone = entry.finalResponse && entry.finalResponse.finishReason === 'stop';
  var status = hasError ? 'error' : (isDone ? 'done' : 'streaming');
  var statusBadge = status === 'error' ? 'badge-danger'
    : status === 'done' ? 'badge-success' : 'badge-accent';
  var rawText = entry.rawFullContent || '';
  var processedText = entry.processedApiOutput || '';
  return '<div class="req-header">'
    + '<span class="req-ts">' + fmtTime(entry.timestamp || Date.now()) + '</span>'
    + '<span class="badge badge-neutral">' + escHtml(model) + '</span>'
    + '<span class="badge ' + (stream ? 'badge-accent' : 'badge-neutral') + '">' + (stream ? 'SSE' : 'SYNC') + '</span>'
    + '<span class="badge ' + statusBadge + '">' + status + '</span>'
    + (entry.tokens ? '<span class="req-status">' + (entry.tokens.prompt + entry.tokens.completion) + ' tok</span>' : '')
    + (entry.accountEmail ? '<span class="badge badge-neutral account-badge">' + escHtml(entry.accountEmail.split('@')[0]) + '</span>' : '')
    + '</div>'
    + '<div class="req-detail">'
    + (entry.errors && entry.errors.length > 0 ? '<div class="req-section-label">Warnings &amp; Errors</div>' + entry.errors.map(function(e) {
        var isWarning = e.indexOf('ECHO') !== -1 || e.indexOf('LOOP') !== -1 || e.indexOf('Loop') !== -1 || e.indexOf('parallel') !== -1;
        var badgeClass = isWarning ? 'badge-warning' : 'badge-danger';
        var label = isWarning ? 'WARN' : 'ERROR';
        return '<div style="margin:4px 0;padding:6px 8px;background:var(--bg-elevated);border-radius:6px;font-family:var(--mono);font-size:0.75rem"><span class="badge ' + badgeClass + '" style="margin-right:6px">' + label + '</span>' + escHtml(e) + '</div>';
      }).join('') : '')
    + (entry.clientRequest?.messages?.length ? '<div class="foldable-section"><div class="foldable-header collapsed" onclick="toggleFold(this)"><span class="fold-toggle">▶</span> Messages (' + entry.clientRequest.messages.length + ')</div><div class="foldable-body collapsed">' + entry.clientRequest.messages.map(function(m) {
        var rc = m.role === 'system' ? 'badge-accent' : m.role === 'user' ? 'badge-neutral' : m.role === 'tool' ? 'badge-warning' : 'badge-success';
        return '<div style="margin:8px 0"><div class="msg-header collapsed" onclick="toggleFold(this)"><span class="fold-toggle">▶</span><span class="badge ' + rc + '">' + escHtml(m.role) + '</span></div><div class="msg-body collapsed"><div class="req-block" style="margin-top:4px"><pre>' + escHtml(m.content) + '</pre></div></div></div>';
      }).join('') + '</div></div>' : '')
    + (entry.qwenRawChunks?.length > 1 ? '<div class="foldable-section"><div class="foldable-header collapsed" onclick="toggleFold(this)"><span class="fold-toggle">▶</span> Raw Chunks (' + entry.qwenRawChunks.length + ')</div><div class="foldable-body collapsed" style="max-height:70vh;overflow-y:auto">' + entry.qwenRawChunks.map(function(c, i) {
        var isJson = c.trim().startsWith('{') && c.includes('"name"');
        var chunkLabel = isJson ? 'tool' : 'text';
        return '<div style="margin:4px 0;padding:4px 6px;border-left:3px solid ' + (isJson ? 'var(--accent)' : 'var(--text-muted)') + ';font-family:var(--mono);font-size:0.7rem"><span class="badge ' + (isJson ? 'badge-accent' : 'badge-neutral') + '" style="margin-right:4px">#' + (i + 1) + ' ' + chunkLabel + '</span>' + escHtml(c) + '</div>';
      }).join('') + '</div></div>' : '')
    + (rawText ? '<div class="foldable-section"><div class="foldable-header" onclick="toggleFold(this)"><span class="fold-toggle">▼</span> Raw AI Response</div><div class="foldable-body"><pre style="white-space:pre-wrap;word-break:break-all;overflow-x:auto">' + escHtml(rawText) + '</pre></div></div>' : '')
    + (processedText ? '<div class="foldable-section"><div class="foldable-header" onclick="toggleFold(this)"><span class="fold-toggle">▼</span> Processed Output</div><div class="foldable-body"><pre style="white-space:pre-wrap;word-break:break-all;overflow-x:auto">' + escHtml(processedText) + '</pre></div></div>' : '')
    + (entry.parsedToolCalls?.length ? '<div class="req-section-label">Tool Execution</div>' + entry.parsedToolCalls.map(function(tc) {
        var s = tc.blocked ? '<span class="badge badge-warning">BLOCKED</span>' : (tc.error ? '<span class="badge badge-danger">ERROR</span>' : '<span class="badge badge-success">SUCCESS</span>');
        var d = '';
        if (tc.blocked) d += 'Reason: ' + escHtml(tc.blockReason || 'N/A') + '<br>';
        if (tc.error) d += 'Error: ' + escHtml(tc.error) + '<br>';
        if (tc.result !== undefined) d += 'Result: ' + escHtml(typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)) + '<br>';
        if (tc.executionTimeMs !== undefined) d += 'Exec time: ' + tc.executionTimeMs + 'ms';
        var prettyArgs = '';
        if (tc.args) { try { prettyArgs = JSON.stringify(JSON.parse(tc.args), null, 2); } catch(e) { prettyArgs = tc.args; } }
        return '<div style="margin:8px 0;padding:8px;background:var(--bg-elevated);border-radius:6px">'
          + '<strong>' + escHtml(tc.name) + '</strong> ' + s + '<br>'
          + (tc.args ? '<div style="margin-top:4px;font-family:var(--mono);font-size:0.8em;white-space:pre-wrap">' + escHtml(prettyArgs) + '</div>' : '')
          + (d ? '<div style="margin-top:4px;font-family:var(--mono);font-size:0.8em;white-space:pre-wrap">' + d + '</div>' : '')
          + '</div>';
      }).join('') : '')
    + '</div>';
}

function addRequestEntry(entry) {
  var empty = document.getElementById('requestLogEmpty');
  if (empty) empty.style.display = 'none';
  var container = document.getElementById('requestLogContainer');
  var entryId = entry.id || entry.request_id;
  var existing = requestEntryMap[entryId];
  if (existing) {
    var el = document.getElementById(existing);
    if (el) el.innerHTML = renderEntryHtml(entry);
    return;
  }
  var divId = 'req-' + entryId;
  var div = document.createElement('div');
  div.className = 'req-entry';
  div.id = divId;
  div.innerHTML = renderEntryHtml(entry);
  container.insertBefore(div, container.firstChild.nextSibling || null);
  requestEntryMap[entryId] = divId;
  requestEntries.push(divId);
  while (requestEntries.length > MAX_REQUEST_ENTRIES) {
    var old = requestEntries.shift();
    var el = document.getElementById(old);
    if (el) el.remove();
    delete requestEntryMap[old.replace('req-', '')];
  }
  if (requestEntries.length > renderLimit) {
    ensureLoadMoreButton(container);
    hideExcessEntries();
  }
}

function ensureLoadMoreButton(container) {
  var existingBtn = document.getElementById('loadMoreBtn');
  if (!existingBtn) {
    var btn = document.createElement('button');
    btn.id = 'loadMoreBtn';
    btn.className = 'load-more-btn';
    btn.textContent = 'Load More (' + (requestEntries.length - renderLimit) + ' hidden)';
    btn.onclick = function() {
      renderLimit += 50;
      showEntriesUpTo(renderLimit);
      updateLoadMoreButton();
    };
    container.appendChild(btn);
  }
}

function hideExcessEntries() {
  for (var i = renderLimit; i < requestEntries.length; i++) {
    var el = document.getElementById(requestEntries[i]);
    if (el) el.style.display = 'none';
  }
}

function showEntriesUpTo(limit) {
  for (var i = 0; i < Math.min(limit, requestEntries.length); i++) {
    var el = document.getElementById(requestEntries[i]);
    if (el) el.style.display = '';
  }
}

function updateLoadMoreButton() {
  var btn = document.getElementById('loadMoreBtn');
  if (!btn) return;
  var hidden = requestEntries.length - renderLimit;
  if (hidden > 0) {
    btn.textContent = 'Load More (' + hidden + ' hidden)';
    btn.disabled = false;
  } else {
    btn.textContent = 'All entries loaded (' + requestEntries.length + ')';
    btn.disabled = true;
  }
}

/* ── Utility ── */
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── Init ── */
function init() {
  apiFetch('/health').then(function(data) {
    if (data && data.uptime != null) {
      var startTime = Date.now() - (data.uptime * 1000);
      setInterval(function() {
        var elapsed = Math.floor((Date.now() - startTime) / 1000);
        var h = Math.floor(elapsed / 3600);
        var m = Math.floor((elapsed % 3600) / 60);
        var s = elapsed % 60;
        setText('kpiUptime', h + 'h ' + m + 'm ' + s + 's');
        setText('kpiUptimeSub', 'since server start');
      }, 1000);
    }
  });
  refreshHealth();
  refreshAccounts();
  refreshPool();
  refreshModelHealth();
  refreshSysLogs();
  renderAccountMgmt();
  connectSSE();
  
  // Account Management form submit
  var mgmtForm = document.getElementById('accountMgmtForm');
  if (mgmtForm) {
    mgmtForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var email = document.getElementById('accountEmailInput').value;
      var password = document.getElementById('accountPasswordInput').value;
      handleAddAccount(email, password);
      mgmtForm.reset();
    });
  }
  
  // Account Management button delegation (login/remove)
  var mgmtTable = document.getElementById('accountMgmtTable');
  if (mgmtTable) {
    mgmtTable.addEventListener('click', function(e) {
      var btn = e.target;
      if (btn.tagName !== 'BUTTON') return;
      var email = btn.getAttribute('data-email');
      var action = btn.getAttribute('data-action');
      if (!email || !action) return;
      if (action === 'login') handleManualLogin(email);
      else if (action === 'remove') handleRemoveAccount(email);
    });
  }
  
  // Polling fallback for SSE
  setInterval(() => {
    refreshHealth();
    refreshAccounts();
    refreshPool();
    refreshModelHealth();
    refreshSysLogs();
    renderAccountMgmt();
  }, 2000);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
</script>
</body>
</html>`;
