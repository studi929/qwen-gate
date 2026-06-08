/* ── Auth helpers ── */
function getStoredApiKey() {
  return sessionStorage.getItem('qwen_api_key') || '';
}
function setStoredApiKey(key) {
  if (key) {
    sessionStorage.setItem('qwen_api_key', key);
  } else {
    sessionStorage.removeItem('qwen_api_key');
  }
}

// Grab ?token= from the URL on page load and store it
(function() {
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token');
  if (token) {
    setStoredApiKey(token);
    // Clean URL (remove token param)
    var url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
  }
})();

var API_KEY = getStoredApiKey();
/* ── Helpers ── */
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}
function authHeaders() {
  var key = getStoredApiKey();
  return key ? { 'Authorization': 'Bearer ' + key } : {};
}
function fmtTime(ts) {
  if (!ts) return '—';
  var d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  var h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + ' ' + ampm;
}
function fmtDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (parts.length === 0 || s > 0) parts.push(s + 's');
  return parts.join(' ');
}
function togglePanel(header) {
  header.classList.toggle('open');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('open');
}
async function apiFetch(url) {
  try {
    var res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}