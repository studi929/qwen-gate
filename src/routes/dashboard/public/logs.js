/* ── State ── */
var MAX_VISIBLE_ENTRIES = 30;
var logEntries = [];
var logEntryMap = {};
var hiddenEntries = [];




function fmtJson(raw) {
  if (!raw) return '';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch(e) { return raw; }
}
function fmtTokens(tokens) {
  if (!tokens) return '';
  var total = (tokens.prompt || 0) + (tokens.completion || 0);
  if (!total) return '';
  return total + ' tok';
}

/* ── Fetch wrapper ── */
function apiFetch(url) {
  var key = getStoredApiKey();
  return fetch(url, {
    headers: key ? { 'Authorization': 'Bearer ' + key } : {}
  }).then(function(r) {
    if (!r.ok) return null;
    return r.json();
  }).catch(function() { return null; });
}

/* ── Connection status ── */
function setConnStatus(state) {
  var el = document.getElementById('connStatus');
  if (!el) return;
  el.className = 'conn-status';
  if (state === 'connected') {
    el.classList.add('connected');
    el.textContent = 'Connected';
  } else if (state === 'connecting') {
    el.classList.add('connecting');
    el.textContent = 'Reconnecting...';
  } else {
    el.classList.add('disconnected');
    el.textContent = 'Disconnected';
  }
}

/* ── SSE Connection (buffered) ── */
  function fetchChunkStream(id, btn) {
    var container = document.getElementById('chunks-' + id);
    if (!container) return;
    if (container.style.display === 'block') {
      container.style.display = 'none';
      btn.textContent = 'Load from disk';
      return;
    }
    btn.textContent = 'Loading...';
    btn.disabled = true;
    fetch('/dashboard/logs/' + encodeURIComponent(id) + '/chunk_stream.txt')
      .then(function(r) { if (!r.ok) throw new Error('Not found'); return r.text(); })
      .then(function(text) {
        var lines = text.split('\\n');
        var html = '';
        for (var i = 0; i < lines.length; i++) {
          if (lines[i]) html += '<div class="chunk-line">' + escHtml(lines[i]) + '</div>';
        }
        container.innerHTML = html || '<div style="color:var(--text-secondary);font-size:0.8rem">No chunks recorded</div>';
        container.style.display = 'block';
        btn.textContent = 'Hide (' + lines.length + ' chunks)';
        btn.disabled = false;
      })
      .catch(function() {
        container.innerHTML = '<div style="color:var(--danger);font-size:0.8rem">Chunk stream not available on disk</div>';
        container.style.display = 'block';
        btn.textContent = 'Not available';
        btn.disabled = false;
      });
  }
  window.fetchChunkStream = fetchChunkStream;

  function fetchLogFile(id, file, containerId, btn) {
    var container = document.getElementById(containerId);
    if (!container) return;
    if (container.style.display === 'block') {
      container.style.display = 'none';
      btn.textContent = 'Load full from disk';
      return;
    }
    btn.textContent = 'Loading...';
    btn.disabled = true;
    fetch('/dashboard/logs/' + encodeURIComponent(id) + '/' + encodeURIComponent(file))
      .then(function(r) { if (!r.ok) throw new Error('Not found'); return r.text(); })
      .then(function(text) {
        container.innerHTML = '<pre class="req-pre" style="max-height:none">' + escHtml(text) + '</pre>';
        container.style.display = 'block';
        btn.textContent = 'Hide full';
        btn.disabled = false;
      })
      .catch(function() {
        container.innerHTML = '<div style="color:var(--danger);font-size:0.8rem">File not available on disk</div>';
        container.style.display = 'block';
        btn.textContent = 'Not available';
        btn.disabled = false;
      });
  }
  window.fetchLogFile = fetchLogFile;

  function connectSSE() {
  setConnStatus('connecting');
  setTimeout(function() {
    var url = '/log/stream';
    var key = getStoredApiKey();
    if (key) url += (url.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(key);
    var es = new EventSource(url);
    es.onmessage = function(ev) {
      msgBuffer.push(ev.data);
      if (!flushTimer) flushTimer = setTimeout(flushBuffer, 100);
    };
    es.onerror = function() {
      es.close();
      setConnStatus('disconnected');
      flushTimer = null;
      msgBuffer = [];
      setTimeout(connectSSE, 3000);
    };
    es.onopen = function() {
      setConnStatus('connected');
    };
  }, 300);
}

/* ── Flush buffered messages ── */
function flushBuffer() {
  flushTimer = null;
  var batch = msgBuffer.splice(0, 50);
  for (var i = 0; i < batch.length; i++) {
    try {
      var entry = JSON.parse(batch[i]);
      addRequestEntry(entry);
    } catch(e) { /* skip malformed entries, continue processing batch */ }
  }
  setConnStatus('connected');
}

/* ── Render a single entry ── */
function renderEntryHtml(entry) {
  var model = entry.model || 'unknown';
  var stream = entry.stream !== false;
  var hasError = entry.errors && entry.errors.length > 0;
  var isDone = entry.finalResponse && entry.finalResponse.finishReason === 'stop';
  var status = hasError ? 'error' : (isDone ? 'done' : 'streaming');
  var statusBadge = status === 'error' ? 'badge-danger' : status === 'done' ? 'badge-success' : 'badge-accent';
  var rawText = entry.rawFullContent || '';
  var processedText = entry.processedApiOutput || '';
  var entryId = entry.id || entry.request_id || ('req-' + Date.now());

  /* Header row */
  var html = '<div class="req-header">'
    + '<span class="req-ts">' + fmtTime(entry.timestamp || Date.now()) + '</span>'
    + '<span class="badge badge-neutral">' + escHtml(model) + '</span>'
    + '<span class="badge ' + (stream ? 'badge-accent' : 'badge-neutral') + '">' + (stream ? 'SSE' : 'SYNC') + '</span>'
    + '<span class="badge ' + statusBadge + '">' + status + '</span>'
    + (entry.tokens ? '<span style="font-family:var(--mono);font-size:0.7rem;color:var(--text-secondary)">' + fmtTokens(entry.tokens) + '</span>' : '')
    + (entry.accountEmail ? '<span class="badge badge-neutral" style="background:var(--accent-soft);color:var(--accent);border:1px solid rgba(224,139,110,0.3)">' + escHtml(entry.accountEmail.split('@')[0]) + '</span>' : '')
    + '</div>';

  /* Error section */
  if (hasError) {
    html += '<div class="req-error-top">';
    for (var ei = 0; ei < entry.errors.length; ei++) {
      var e = entry.errors[ei];
      var isWarn = e.indexOf('LOOP') !== -1 || e.indexOf('Loop') !== -1 || e.indexOf('parallel') !== -1;
      var badgeClass = isWarn ? 'badge-warning' : 'badge-danger';
      var label = isWarn ? 'WARN' : 'ERROR';
      html += '<div style="margin:4px 0;padding:6px 8px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-family:var(--mono);font-size:0.75rem"><span class="badge ' + badgeClass + '" style="margin-right:6px">' + label + '</span>' + escHtml(e) + '</div>';
    }
    html += '</div>';
  }

  /* Entry details */
  html += '<div class="req-detail">';

  /* Input — folded by default */
  if (entry.clientRequest && entry.clientRequest.messages && entry.clientRequest.messages.length > 0) {
    html += '<div class="foldable-section"><div class="foldable-header collapsed" onclick="toggleFold(this)"><span class="fold-toggle">▶</span> Input (' + entry.clientRequest.messages.length + ' msgs)</div><div class="foldable-body collapsed">';
    for (var mi = 0; mi < entry.clientRequest.messages.length; mi++) {
      var m = entry.clientRequest.messages[mi];
      var rc = m.role === 'system' ? 'badge-accent' : m.role === 'user' ? 'badge-neutral' : m.role === 'tool' ? 'badge-warning' : 'badge-success';
      html += '<div style="margin:8px 0"><div class="msg-header collapsed" onclick="toggleFold(this)"><span class="fold-toggle">▶</span><span class="badge ' + rc + '">' + escHtml(m.role) + '</span></div><div class="msg-body collapsed"><div class="req-block" style="margin-top:4px"><pre>' + escHtml(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + '</pre></div></div></div>';
    }
    html += '</div></div>';
  }

  /* Raw Output + Processed Output — side by side, folded by default, toggle together */
  if (rawText || processedText) {
    html += '<div class="req-output-grid">';
    if (rawText) {
      html += '<div class="foldable-section"><div class="foldable-header collapsed" onclick="toggleOutputPair(this)"><span class="fold-toggle">▶</span> Raw Output</div><div class="foldable-body collapsed"><pre style="margin:0;white-space:pre-wrap;word-break:break-all;overflow-x:auto;font-family:var(--mono);font-size:0.7rem;line-height:1.6;color:var(--text-primary)">' + escHtml(rawText) + '</pre></div></div>';
    }
    if (processedText) {
      html += '<div class="foldable-section"><div class="foldable-header collapsed" onclick="toggleOutputPair(this)"><span class="fold-toggle">▶</span> Processed Output</div><div class="foldable-body collapsed"><pre style="margin:0;white-space:pre-wrap;word-break:break-all;overflow-x:auto;font-family:var(--mono);font-size:0.7rem;line-height:1.6;color:var(--text-primary)">' + escHtml(processedText) + '</pre></div></div>';
    }
    html += '</div>';
  }

  /* Tool Calls — folded by default */
  if (entry.parsedToolCalls && entry.parsedToolCalls.length > 0) {
    html += '<div class="foldable-section"><div class="foldable-header collapsed" onclick="toggleFold(this)"><span class="fold-toggle">▶</span> Tool Calls (' + entry.parsedToolCalls.length + ')</div><div class="foldable-body collapsed">';
    for (var ti = 0; ti < entry.parsedToolCalls.length; ti++) {
      var tc = entry.parsedToolCalls[ti];
      var s = tc.blocked ? '<span class="badge badge-warning">BLOCKED</span>' : (tc.error ? '<span class="badge badge-danger">ERROR</span>' : '<span class="badge badge-success">SUCCESS</span>');
      var d = '';
      if (tc.blocked) d += 'Reason: ' + escHtml(tc.blockReason || 'N/A') + '<br>';
      if (tc.error) d += 'Error: ' + escHtml(tc.error) + '<br>';
      if (tc.result !== undefined) d += 'Result: ' + escHtml(typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)) + '<br>';
      if (tc.executionTimeMs !== undefined) d += 'Exec time: ' + tc.executionTimeMs + 'ms';
      var prettyArgs = '';
      if (tc.args) { try { prettyArgs = JSON.stringify(JSON.parse(tc.args), null, 2); } catch(err) { prettyArgs = tc.args; } }
      html += '<div style="margin:8px 0;padding:8px;background:var(--bg-elevated);border-radius:var(--radius-sm)">'
        + '<strong>' + escHtml(tc.name) + '</strong> ' + s + '<br>'
        + (tc.args ? '<div style="margin-top:4px;font-family:var(--mono);font-size:0.8em;white-space:pre-wrap">' + escHtml(prettyArgs) + '</div>' : '')
        + (d ? '<div style="margin-top:4px;font-family:var(--mono);font-size:0.8em;white-space:pre-wrap">' + d + '</div>' : '')
        + '</div>';
    }
    html += '</div></div>';
  }

  html += '</div>'; /* end req-detail */

  return html;
}

/* ── Add entry to DOM ── */
function addRequestEntry(entry) {
  var entryId = entry.id || entry.request_id;
  if (!entryId) return;

  var existing = logEntryMap[entryId];
  if (existing) {
    /* Skip DOM update for hidden entries to save CPU */
    if (hiddenEntries.indexOf(existing) !== -1) return;
    var el = document.getElementById(existing);
    if (el) el.innerHTML = renderEntryHtml(entry);
    return;
  }

  var empty = document.getElementById('requestLogEmpty');
  if (empty) empty.style.display = 'none';

  /* Remove loading skeletons */
  var skels = document.querySelectorAll('.skeleton');
  for (var i = 0; i < skels.length; i++) skels[i].remove();

  var container = document.getElementById('requestLogContainer');
  var divId = 'req-' + entryId;
  var div = document.createElement('div');
  div.className = 'req-entry';
  div.id = divId;
  div.innerHTML = renderEntryHtml(entry);

  container.insertBefore(div, container.firstChild || null);
  logEntryMap[entryId] = divId;
  logEntries.unshift(divId);

  /* Enforce max visible count */
  while (logEntries.length > MAX_VISIBLE_ENTRIES) {
    var excess = logEntries.pop();
    var excessEl = document.getElementById(excess);
    if (excessEl) {
      excessEl.remove();
      delete logEntryMap[excess];
    }
  }

  updateCounts();
}

/* ── Update counters ── */
function updateCounts() {
  var total = logEntries.length + hiddenEntries.length;
  var countEl = document.getElementById('entryCount');
  if (countEl) countEl.textContent = total + (total === 1 ? ' entry' : ' entries');
}

/* ── Clear Log ── */
function clearLog() {
  var container = document.getElementById('requestLogContainer');
  var entries = container.querySelectorAll('.req-entry');
  for (var i = 0; i < entries.length; i++) entries[i].remove();
  logEntries = [];
  logEntryMap = {};
  hiddenEntries = [];

  var empty = document.getElementById('requestLogEmpty');
  if (empty) empty.style.display = '';
  updateCounts();
}

/* ── Toggle individual foldable section ── */
function toggleFold(header) {
  header.classList.toggle('collapsed');
  var body = header.nextElementSibling;
  if (!body) return;
  body.classList.toggle('collapsed');
}

/* ── Toggle raw+processed output pair together ── */
function toggleOutputPair(header) {
  header.classList.toggle('collapsed');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
  var grid = header.closest('.req-output-grid');
  if (grid) {
    var others = grid.querySelectorAll('.foldable-header');
    for (var i = 0; i < others.length; i++) {
      if (others[i] === header) continue;
      others[i].classList.toggle('collapsed');
      var siblingBody = others[i].nextElementSibling;
      if (siblingBody) siblingBody.classList.toggle('collapsed');
    }
  }
}

/* ── Poll for new entries ── */
function pollLogs() {
  apiFetch('/log/json').then(function(data) {
    if (Array.isArray(data) && data.length > 0) {
      for (var i = data.length - 1; i >= 0; i--) {
        var entry = data[i];
        if (!logEntryMap[entry.id || entry.request_id]) {
          addRequestEntry(entry);
        }
      }
    }
  });
}

/* ── Init ── */
function init() {
  connectSSE();

  /* Fetch existing entries + poll every 2 seconds for auto-refresh */
  pollLogs();
  setInterval(pollLogs, 2000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}