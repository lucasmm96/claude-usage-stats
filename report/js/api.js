// ---- Database / API loader ----

async function fetchFromApi(apiUrl, apiKey) {
  // Empty apiUrl = same-origin (report and API on the same Vercel deployment)
  const base = (apiUrl || '').replace(/\/$/, '');
  const url = base + '/api/sessions';
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (res.status === 401) throw new Error('Invalid API key (401 Unauthorized)');
  if (res.status === 403) throw new Error('Access denied (403 Forbidden)');
  if (res.status === 404) throw new Error('API endpoint not found (404) — check API URL');
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.text();
}

async function tryAutoLoadApi() {
  let apiUrl, apiKey;
  try {
    apiUrl = localStorage.getItem(LS_API_URL) || '';
    apiKey = localStorage.getItem(LS_API_KEY);
  } catch(e) { return; }
  if (!apiKey) return; // apiUrl is optional: empty = same-origin
  updateApiButton(true);
  try {
    const text = await fetchFromApi(apiUrl, apiKey);
    loadJson(text, { type: 'api', apiUrl, apiKey });
  } catch(e) {
    updateApiButton(false);
    console.warn('Auto-load from API failed:', e.message);
  }
}

// ---- Modal ----
function openApiModal() {
  let apiUrl = '', apiKey = '';
  try {
    apiUrl = localStorage.getItem(LS_API_URL) || '';
    apiKey = localStorage.getItem(LS_API_KEY) || '';
  } catch(e) {}
  document.getElementById('a-url').value = apiUrl;
  document.getElementById('a-key').value = apiKey;
  document.getElementById('api-modal-status').textContent = '';
  document.getElementById('api-modal-status').className = '';
  document.getElementById('api-clear-btn').style.display = apiKey ? 'inline-flex' : 'none';
  document.getElementById('api-export-btn').disabled = !apiKey;
  document.getElementById('api-modal-overlay').classList.add('open');
  document.getElementById('a-url').focus();
}

function closeApiModal() {
  document.getElementById('api-modal-overlay').classList.remove('open');
}

function toggleApiKey() {
  const el = document.getElementById('a-key');
  const btn = document.getElementById('api-key-toggle');
  if (el.type === 'password') { el.type = 'text'; btn.textContent = 'Hide'; }
  else { el.type = 'password'; btn.textContent = 'Show'; }
}

async function connectApi() {
  const apiUrl = document.getElementById('a-url').value.trim();
  const apiKey  = document.getElementById('a-key').value.trim();
  const btn     = document.getElementById('api-connect-btn');

  if (!apiKey) { setApiModalStatus('err', 'API Key is required.'); return; }

  btn.textContent = 'Connecting…';
  btn.disabled = true;
  setApiModalStatus('', '');

  try {
    const text = await fetchFromApi(apiUrl, apiKey);
    try {
      localStorage.setItem(LS_API_URL, apiUrl);
      localStorage.setItem(LS_API_KEY, apiKey);
    } catch(e) {}
    setApiModalStatus('ok', 'Connected to database');
    document.getElementById('api-clear-btn').style.display = 'inline-flex';
    document.getElementById('api-export-btn').disabled = false;
    updateApiButton(true);
    loadJson(text, { type: 'api', apiUrl, apiKey });
    setTimeout(closeApiModal, 800);
  } catch(e) {
    setApiModalStatus('err', e.message);
  } finally {
    btn.textContent = 'Connect';
    btn.disabled = false;
  }
}

function clearApiCredentials() {
  if (!confirm('Remove saved API credentials from this browser?')) return;
  try {
    localStorage.removeItem(LS_API_URL);
    localStorage.removeItem(LS_API_KEY);
  } catch(e) {}
  document.getElementById('a-url').value = '';
  document.getElementById('a-key').value = '';
  document.getElementById('api-clear-btn').style.display = 'none';
  document.getElementById('api-export-btn').disabled = true;
  updateApiButton(false);
  setApiModalStatus('ok', 'Credentials cleared.');
}

// ---- Export ----

// Normalizes a database timestamp to the local log format: UTC 'Z' suffix and
// exactly three millisecond digits (Postgres trims trailing zeros, e.g.
// "...34.5+00:00" comes back as "...34.500Z").
function apiTsToLocal(iso) {
  if (!iso) return iso;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso; // unparseable: keep as-is
  return d.toISOString();
}

// Rebuilds a session in the exact shape and key order the hook script writes
// locally (docs/log-format.md): session_name, profile, model, started_at,
// last_activity_at, _state (present keys only), log entries with `at` first.
// Null-valued keys from the read-handler are preserved as explicit nulls.
function buildLocalSession(s) {
  const st = s._state || {};
  const out = { session_id: s.session_id };
  if ('session_name' in s) out.session_name = s.session_name;
  if ('profile' in s) out.profile = s.profile;
  if ('model' in s) out.model = s.model;
  if ('started_at' in s) out.started_at = apiTsToLocal(s.started_at);
  if ('last_activity_at' in s) out.last_activity_at = apiTsToLocal(s.last_activity_at);
  // _state: only the keys the database has, in the hook script's write order
  // (old sessions predate custom_title/title_scan_offset/real_model).
  out._state = {};
  for (const k of ['total_in', 'total_out', 'last_ctx', 'custom_title', 'title_scan_offset', 'real_model']) {
    if (k in st) out._state[k] = st[k];
  }
  out.log = (s.log || []).map(e => {
    const entry = { at: apiTsToLocal(e.at) };
    if (e.event) entry.event = e.event;
    if (e.input_tokens != null) entry.input_tokens = e.input_tokens;
    if (e.cache_read_tokens != null) entry.cache_read_tokens = e.cache_read_tokens;
    if (e.cache_write_tokens != null) entry.cache_write_tokens = e.cache_write_tokens;
    if (e.output_tokens != null) entry.output_tokens = e.output_tokens;
    if (e.context_pct != null) entry.context_pct = e.context_pct;
    if (e.model != null) entry.model = e.model;
    return entry;
  });
  return out;
}

async function exportApiData() {
  let apiUrl = '', apiKey = null;
  try {
    apiUrl = localStorage.getItem(LS_API_URL) || '';
    apiKey = localStorage.getItem(LS_API_KEY);
  } catch(e) {}
  const btn = document.getElementById('api-export-btn');
  if (!btn) return;
  if (!apiKey) { setApiModalStatus('err', 'Save your API key first.'); return; }
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  setApiModalStatus('', '');
  try {
    const text = await fetchFromApi(apiUrl, apiKey);
    const data = JSON.parse(text);
    if (!data || data.error || !data.sessions) {
      throw new Error(data && data.error ? data.error : 'Unexpected API response');
    }
    const sessions = {};
    for (const [id, s] of Object.entries(data.sessions)) sessions[id] = buildLocalSession(s);
    const out = JSON.stringify({ sessions }, null, 2);
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([out], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `claude-usage-stats-export-${date}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    setApiModalStatus('ok', `Exported ${Object.keys(sessions).length} sessions (${(out.length / 1048576).toFixed(2)} MB)`);
  } catch(e) {
    setApiModalStatus('err', 'Export failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

function setApiModalStatus(type, msg) {
  const el = document.getElementById('api-modal-status');
  el.textContent = msg;
  el.className = type;
}

function updateApiButton(connected) {
  const btn = document.getElementById('api-btn');
  if (!btn) return;
  if (connected) {
    btn.textContent = '📄 Database ✓';
    btn.classList.add('btn-connected');
  } else {
    btn.textContent = '📄 Database';
    btn.classList.remove('btn-connected');
  }
}
