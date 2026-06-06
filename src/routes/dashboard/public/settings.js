var settingsData = {};

var SETTINGS_SECTIONS = [
  { title: 'Server', desc: 'Port, security, and browser engine settings.', fields: [
    { key: 'PORT', label: 'PORT', type: 'number' },
    { key: 'API_KEY', label: 'API_KEY', type: 'password' },
    { key: 'BROWSER', label: 'BROWSER', type: 'select', options: [
      { value: 'chromium', label: 'Chromium' },
      { value: 'firefox', label: 'Firefox' },
      { value: 'chrome', label: 'Chrome' },
      { value: 'edge', label: 'Edge' }
    ]}
  ]},
  { title: 'Pipeline', desc: 'Output transformation, streaming mode, and tool-call behaviour.', fields: [
    { key: 'TOOL_CALLING', label: 'TOOL_CALLING', type: 'checkbox' },
    { key: 'CLEAN_OUTPUT', label: 'CLEAN_OUTPUT', type: 'checkbox' },
    { key: 'STREAMING_MODE', label: 'STREAMING_MODE', type: 'select', options: [
      { value: 'auto', label: 'Auto (respect client)' },
      { value: 'stream', label: 'Always stream' },
      { value: 'non-stream', label: 'Never stream' }
    ]}
  ]},
  { title: 'Echo Detector', desc: 'Prevent tool-call and prompt echo leaks in output.', fields: [
    { key: 'ECHO_DETECTOR', label: 'ECHO_DETECTOR', type: 'checkbox' },
    { key: 'ECHO_JACCARD_THRESHOLD', label: 'ECHO_JACCARD_THRESHOLD', type: 'number', step: '0.1' },
    { key: 'ECHO_MIN_LINE_LENGTH', label: 'ECHO_MIN_LINE_LENGTH', type: 'number' },
    { key: 'ECHO_MIN_UNIQUE_SHINGLES', label: 'ECHO_MIN_UNIQUE_SHINGLES', type: 'number' }
  ]},
  { title: 'Session & Auth', desc: 'Token lifetimes, refresh windows, and session cleanup.', fields: [
    { key: 'QWEN_FETCH_TIMEOUT_MS', label: 'QWEN_FETCH_TIMEOUT_MS', type: 'number' },
    { key: 'AUTH_TOKEN_MAX_AGE_MS', label: 'AUTH_TOKEN_MAX_AGE_MS', type: 'number' },
    { key: 'AUTH_REFRESH_BEFORE_MS', label: 'AUTH_REFRESH_BEFORE_MS', type: 'number' },
    { key: 'DELETE_SESSION', label: 'DELETE_SESSION', type: 'checkbox' }
  ]},
  { title: 'Rate Limiting', desc: 'Cooldowns and throttling to prevent account bans.', fields: [
    { key: 'RATE_LIMIT_COOLDOWN_MS', label: 'RATE_LIMIT_COOLDOWN_MS', type: 'number' }
  ]},
  { title: 'Logging', desc: 'Per-request log storage and retention.', fields: [
    { key: 'SAVE_REQUEST_LOGS', label: 'SAVE_REQUEST_LOGS', type: 'checkbox' },
    { key: 'MAX_LOGS', label: 'MAX_LOGS', type: 'number' }
  ]},
  { title: 'System & Accounts', desc: 'System prompts and account management actions.', fields: [
    { key: 'USE_CUSTOM_INSTRUCTION', label: 'USE_CUSTOM_INSTRUCTION', type: 'checkbox' },
    { key: 'CUSTOM_INSTRUCTION', label: 'CUSTOM_INSTRUCTION', type: 'text' },
    { key: '_delete_all_chats', type: 'action', label: 'Delete All Chats', desc: 'Removes all conversations from every Qwen account', action: 'deleteAllChats' }
  ]}
];

/* ── Render ── */
function renderSettingsForm() {
  var container = document.getElementById('settingsSections');
  var html = '';
  for (var s = 0; s < SETTINGS_SECTIONS.length; s++) {
    var section = SETTINGS_SECTIONS[s];
    html += '<fieldset class="settings-section">'
      + '<div class="settings-section-title">' + escHtml(section.title) + '</div>'
      + '<p class="settings-section-desc">' + escHtml(section.desc) + '</p>'
      + '<div class="settings-fields">';
    for (var f = 0; f < section.fields.length; f++) {
      var field = section.fields[f];
      var val = settingsData[field.key] !== undefined ? settingsData[field.key] : '';
      html += renderSettingsField(field, val);
    }
    html += '</div></fieldset>';
  }
  container.innerHTML = html;
}

function renderSettingsField(field, val) {
  if (field.type === 'action') {
    return '<div class="settings-field" style="grid-column:span 2">'
      + '<label>' + escHtml(field.label) + '</label>'
      + '<p style="font-size:0.75rem;color:var(--text-secondary);margin:0 0 8px">' + escHtml(field.desc || '') + '</p>'
      + '<button class="save-btn" style="background:var(--danger)" onclick="handleSettingsAction(\'' + field.action + '\')">' + escHtml(field.label) + '</button></div>';
  }
  if (field.type === 'checkbox') {
    var checked = val === 'true' ? ' checked' : '';
    return '<label class="settings-checkbox">'
      + '<input type="checkbox" data-key="' + field.key + '"' + checked + ' onchange="onCheckboxChange(this)">'
      + '<span>' + escHtml(field.label) + '</span></label>';
  }
  if (field.key === 'CUSTOM_INSTRUCTION') {
    return '<div class="settings-field" style="grid-column:span 2">'
      + '<label for="cfg-CUSTOM_INSTRUCTION">' + escHtml(field.label) + '</label>'
      + '<textarea id="cfg-CUSTOM_INSTRUCTION" data-key="CUSTOM_INSTRUCTION" rows="4" style="width:100%;resize:vertical;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;font-family:var(--mono);font-size:0.75rem;color:var(--text-primary)" oninput="onFieldChange(this)">' + escHtml(val) + '</textarea></div>';
  }
  if (field.type === 'select') {
    var opts = '';
    for (var o = 0; o < field.options.length; o++) {
      var opt = field.options[o];
      var sel = opt.value === val ? ' selected' : '';
      opts += '<option value="' + escHtml(opt.value) + '"' + sel + '>' + escHtml(opt.label) + '</option>';
    }
    return '<div class="settings-field">'
      + '<label for="cfg-' + field.key + '">' + escHtml(field.label) + '</label>'
      + '<select id="cfg-' + field.key + '" data-key="' + field.key + '" onchange="onFieldChange(this)">' + opts + '</select></div>';
  }
  var inputType = field.type || 'text';
  var stepAttr = field.step ? ' step="' + field.step + '"' : '';
  return '<div class="settings-field">'
    + '<label for="cfg-' + field.key + '">' + escHtml(field.label) + '</label>'
    + '<input type="' + inputType + '" id="cfg-' + field.key + '" data-key="' + field.key + '" value="' + escHtml(val) + '"' + stepAttr + ' oninput="onFieldChange(this)"></div>';
}

/* ── Change tracking ── */
function onFieldChange(el) {
  settingsData[el.getAttribute('data-key')] = el.value;
}
function onCheckboxChange(el) {
  var key = el.getAttribute('data-key');
  settingsData[key] = el.checked ? 'true' : '';
}

/* ── Load ── */
async function loadSettings() {
  try {
    var headers = {};
    if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;
    var res = await fetch('/api/config', { headers: headers });
    if (res.ok) {
      var data = await res.json();
      if (data && data.config) {
        settingsData = {};
        var keys = Object.keys(data.config);
        for (var i = 0; i < keys.length; i++) {
          settingsData[keys[i]] = data.config[keys[i]];
        }
      }
    }
  } catch(e) {
    console.error('Settings load error:', e);
  }
  renderSettingsForm();
}

/* ── Save ── */
async function saveSettings() {
  var btn = document.getElementById('settingsSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  var msgEl = document.getElementById('settingsMessage');
  try {
    var headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;
    var res = await fetch('/api/config', {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(settingsData)
    });
    var result = await res.json();
    if (!res.ok) {
      msgEl.innerHTML = '<div class="settings-message error">' + escHtml(result.error || 'Save failed (' + res.status + ')') + '</div>';
    } else {
      if (result.config) {
        var keys = Object.keys(result.config);
        for (var i = 0; i < keys.length; i++) {
          settingsData[keys[i]] = result.config[keys[i]];
        }
        renderSettingsForm();
      }
      msgEl.innerHTML = '<div class="settings-message success">Settings saved successfully.</div>';
      setTimeout(function() { msgEl.innerHTML = ''; }, 4000);
    }
  } catch(e) {
    msgEl.innerHTML = '<div class="settings-message error">' + escHtml(e.message) + '</div>';
  }
  btn.disabled = false;
  btn.textContent = 'Save Changes';
}

/* ── Modal ── */
function showModal(title, bodyHtml, footerHtml) {
  document.getElementById('modalHeader').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFooter').innerHTML = footerHtml;
  document.getElementById('confirmModal').style.display = 'flex';
}
function hideModal() {
  document.getElementById('confirmModal').style.display = 'none';
}

/* ── Actions ── */
async function handleSettingsAction(action) {
  if (action === 'deleteAllChats') {
    var bodyHtml = '<p style="margin:0 0 12px">This will permanently <strong>delete all conversations</strong> from every Qwen account.</p>'
      + '<p style="margin:0;color:var(--danger)"><strong>This action cannot be undone.</strong></p>';
    var footerHtml = '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Cancel</button>'
      + '<button class="modal-btn modal-btn-primary" id="confirmDeleteBtn" onclick="executeDeleteAllChats()">Yes, delete all</button>';
    showModal('Delete All Chats', bodyHtml, footerHtml);
  }
}

async function executeDeleteAllChats() {
  var btn = document.getElementById('confirmDeleteBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }
  document.getElementById('modalFooter').innerHTML = '<span style="font-size:0.8125rem;color:var(--text-secondary)">Processing...</span>';
  var bodyEl = document.getElementById('modalBody');
  bodyEl.innerHTML = '<div id="deleteProgress"></div>';
  var progressEl = document.getElementById('deleteProgress');
  var doneCount = 0;
  var errorCount = 0;
  try {
    var headers = {};
    if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;
    var res = await fetch('/dashboard/accounts/delete-all-chats', { method: 'POST', headers: headers });
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || !line.startsWith('data: ')) continue;
        try {
          var data = JSON.parse(line.slice(6));
          if (data.type === 'result') {
            progressEl.innerHTML += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-weight:600;color:var(--success)">[OK] Done: ' + data.deleted + ' / ' + data.total + ' accounts</div>';
            if (data.errors && data.errors.length > 0) {
              for (var ei = 0; ei < data.errors.length; ei++) {
                progressEl.innerHTML += '<div style="color:var(--danger);font-size:0.75rem;padding:2px 0">[FAIL] ' + escHtml(data.errors[ei]) + '</div>';
              }
            }
            var footerHtml = '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Close</button>';
            document.getElementById('modalFooter').innerHTML = footerHtml;
            return;
          }
          if (data.type === 'progress') {
            if (data.status === 'deleting') {
              progressEl.innerHTML += '<div id="prog-' + escHtml(data.email.replace(/[@.]/g,'_')) + '" style="color:var(--text-secondary);padding:3px 0;font-size:0.75rem">\u2026 ' + escHtml(data.email) + '...</div>';
            } else if (data.status === 'done') {
              doneCount++;
              var progEl = document.getElementById('prog-' + escHtml(data.email.replace(/[@.]/g,'_')));
              if (progEl) { progEl.outerHTML = '<div style="color:var(--success);padding:3px 0;font-size:0.75rem">[OK] ' + escHtml(data.email) + '</div>'; }
              else { progressEl.innerHTML += '<div style="color:var(--success);padding:3px 0;font-size:0.75rem">[OK] ' + escHtml(data.email) + '</div>'; }
            } else if (data.status === 'error') {
              errorCount++;
              var progEl = document.getElementById('prog-' + escHtml(data.email.replace(/[@.]/g,'_')));
              if (progEl) { progEl.outerHTML = '<div style="color:var(--danger);padding:3px 0;font-size:0.75rem">[FAIL] ' + escHtml(data.email) + ': ' + escHtml(data.error) + '</div>'; }
              else { progressEl.innerHTML += '<div style="color:var(--danger);padding:3px 0;font-size:0.75rem">[FAIL] ' + escHtml(data.email) + ': ' + escHtml(data.error) + '</div>'; }
            }
            progressEl.scrollTop = progressEl.scrollHeight;
          }
        } catch(e) {}
      }
    }
    /* If stream ended with no result event, show fallback */
    var footerHtml = '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Close</button>';
    document.getElementById('modalFooter').innerHTML = footerHtml;
    if (doneCount === 0 && errorCount === 0) {
      progressEl.innerHTML = '<div style="color:var(--text-secondary)">No accounts processed. The server may have returned an error.</div>';
    }
  } catch(e) {
    bodyEl.innerHTML = '<p style="color:var(--danger)">Error: ' + escHtml(e.message) + '</p>';
    var footerHtml = '<button class="modal-btn modal-btn-secondary" onclick="hideModal()">Close</button>';
    document.getElementById('modalFooter').innerHTML = footerHtml;
  }
}

function showToast(msg, type) {
  var container = document.getElementById('toastContainer') || document.body;
  var el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(function() { el.remove(); }, 4000);
}

/* ── Init ── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSettings);
} else {
  loadSettings();
}