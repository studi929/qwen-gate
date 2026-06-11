function fmtTTL(ms) {
  if (ms == null || ms < 0) return '\u2014';
  var m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  m %= 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function showToast(message, type) {
  var container = document.getElementById('toastContainer');
  var toast = document.createElement('div');
  toast.className = 'toast ' + (type || 'info');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, 3500);
}

function setError(msg) {
  var box = document.getElementById('errorBox');
  if (msg) {
    box.textContent = msg;
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}



/* ── Accounts Table ── */
function getAuthStatus(acct) {
  if (acct.authenticated) return 'live';
  if (acct.throttled) return 'throttled';
  if (acct.tokenExpiresInMs != null && acct.tokenExpiresInMs < 0) return 'expired';
  return 'unknown';
}

function getAuthLabel(status) {
  if (status === 'live') return 'Authenticated';
  if (status === 'expired') return 'Expired';
  if (status === 'throttled') return 'Throttled';
  return 'Not authenticated';
}

function makeThrottleBadge(acct) {
  if (acct.throttled) {
    var label = 'Throttled';
    if (acct.throttledRemainingMs != null) label += ' ' + fmtTTL(acct.throttledRemainingMs);
    return '<span class="badge badge-warning">' + label + '</span>';
  }
  return '<span class="badge badge-neutral">OK</span>';
}

function renderAccountsTable(accts) {
  if (!Array.isArray(accts) || accts.length === 0) {
    document.getElementById('acctBody').innerHTML = '';
    document.getElementById('emptyState').style.display = '';
    setText('acctCount', '');
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  setText('acctCount', accts.length + ' total');
  var rows = '';
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var status = getAuthStatus(a);
    var label = getAuthLabel(status);
    var hideLogin = status === 'live' ? ' style="display:none"' : '';
    rows += '<tr>'
      + '<td>' + escHtml(a.email) + '</td>'
      + '<td><div class="auth-status"><span class="auth-dot ' + status + '"></span>' + label + '</div></td>'
      + '<td>' + (a.inFlight || 0) + '</td>'
      + '<td>' + (a.totalRequests || 0) + '</td>'
      + '<td>' + makeThrottleBadge(a) + '</td>'
      + '<td style="font-family:var(--mono);font-size:0.75rem">' + fmtTTL(a.tokenExpiresInMs) + '</td>'
      + '<td><div class="action-cell">'
      + '<button class="account-btn small danger" data-email="' + escHtml(a.email) + '" data-action="remove">Remove</button>'
      + '<button class="account-btn small primary" data-email="' + escHtml(a.email) + '" data-action="login"' + hideLogin + '>Login</button>'
      + '</div></td></tr>';
  }
  document.getElementById('acctBody').innerHTML = rows;
}

/* ── Load Accounts ── */
async function loadAccounts() {
  var data = await apiFetch('/accounts');
  renderAccountsTable(data);
}

/* ── Add Account ── */
function handleAdd(email, password) {
  var btn = document.getElementById('addBtn');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  setError(null);
  (async function() {
    try {
      var res = await fetch('/api/accounts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ email: email, password: password })
      });
      var result;
      try { result = await res.json(); } catch(e) { result = null; }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Failed to add account (' + res.status + ')');
      }
      if (result.loginSucceeded) {
        showToast('Account added and logged in: ' + email, 'success');
        pollAuth(email, 15);
      } else {
        showToast((result.loginError || 'Account added but login failed. Click Login to open browser.'), 'warning');
        pollAuth(email, 15);
      }
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Account';
    }
  })();
}

/* ── Remove Account ── */
function handleRemove(email) {
  document.getElementById('confirmEmail').textContent = email;
  document.getElementById('confirmOverlay').classList.add('open');
  document.getElementById('confirmYes').onclick = async function() {
    document.getElementById('confirmOverlay').classList.remove('open');
    setError(null);
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email), {
        method: 'DELETE',
        headers: authHeaders()
      });
      var result;
      try { result = await res.json(); } catch(e) { result = null; }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Failed to remove account (' + res.status + ')');
      }
      showToast('Account removed: ' + email, 'success');
      loadAccounts();
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  };
  document.getElementById('confirmNo').onclick = function() {
    document.getElementById('confirmOverlay').classList.remove('open');
  };
}

/* ── Manual Login (Autofill) ── */
function handleManualLogin(email) {
  var btn = document.querySelector('button[data-email="' + escHtml(email) + '"][data-action="login"]');
  if (btn) { btn.textContent = 'Authorizing...'; btn.disabled = true; }
  setError(null);
  (async function() {
    try {
      var res = await fetch('/api/accounts/' + encodeURIComponent(email) + '/autofill', {
        method: 'GET',
        headers: authHeaders()
      });
      var result;
      try { result = await res.json(); } catch(e) { result = null; }
      if (!res.ok) {
        throw new Error(result && result.error && result.error.message ? result.error.message : 'Login failed (' + res.status + ')');
      }
      if (result && result.authenticated) {
        showToast('Profile authorized for ' + email, 'success');
      } else {
        showToast('Authorization in progress for ' + email + '...', 'warning');
        pollAuth(email, 30);
}
      pollAuth(email, 30);
    } catch (e) {
      setError(e.message);
      showToast(e.message, 'error');
    }
  })();
}

/* ── Poll Auth ── */
function pollAuth(email, maxAttempts) {
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
          loadAccounts();
          return;
        }
      }
    } catch(e) { clearInterval(timer); }
    if (attempt >= maxAttempts) { clearInterval(timer); loadAccounts(); }
  }, 2000);
}

/* ── Init ── */
function init() {
  /* Load on start */
  loadAccounts();

  /* Auto-poll every 2 seconds */
  setInterval(loadAccounts, 2000);

  /* Add form submit */
  document.getElementById('addForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var email = document.getElementById('emailInput').value.trim();
    var password = document.getElementById('passwordInput').value;
    if (!email || !password) {
      showToast('Email and password are required', 'error');
      return;
    }
    handleAdd(email, password);
    this.reset();
  });

  /* Table button delegation */
  document.getElementById('acctTable').addEventListener('click', function(e) {
    var btn = e.target;
    if (btn.tagName !== 'BUTTON') return;
    var email = btn.getAttribute('data-email');
    var action = btn.getAttribute('data-action');
    if (!email || !action) return;
    if (action === 'login') handleManualLogin(email);
    else if (action === 'remove') handleRemove(email);
  });

  /* Close modal on overlay click */
  document.getElementById('confirmOverlay').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}