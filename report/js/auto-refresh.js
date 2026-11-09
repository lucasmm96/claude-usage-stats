// ---- Auto-refresh (URL and GitHub modes only) ----
const _AR_POLL_MS   = [60_000, 120_000, 300_000];
const _AR_DEDUPE_MS = 30_000;
const _AR_MAX_FAIL  = 3;

let _arTimer    = null;
let _arSource   = null; // { type: 'url', url } | { type: 'github', pat, repo, file }
let _arEtag     = null;
let _arLastSig  = '';
let _arFailures = 0;
let _arLastAt   = 0;

// ---- Public API ----
function startAutoRefresh(source) {
  stopAutoRefresh();
  _arSource   = source;
  _arFailures = 0;
  _arEtag     = null;
  _arLastSig  = _arSig(globalData);
  _arLastAt   = Date.now();
  _arSchedule(_AR_POLL_MS[0]);
  setIndicator('idle');
}

function stopAutoRefresh() {
  if (_arTimer) { clearTimeout(_arTimer); _arTimer = null; }
  _arSource = null;
  setIndicator('hidden');
}

// ---- Scheduling ----
function _arSchedule(ms) {
  if (_arTimer) { clearTimeout(_arTimer); _arTimer = null; }
  if (_arSource) _arTimer = setTimeout(_arTick, ms);
}

async function _arTick() {
  _arTimer = null;
  if (!_arSource || document.hidden) return;
  await _arDoFetch();
}

// ---- Fetch cycle ----
async function _arDoFetch() {
  if (!_arSource) return;
  setIndicator('loading');
  _arLastAt = Date.now();

  try {
    const { text, etag, notModified } = await _arFetch();

    if (notModified) { _arSucceed(); return; }

    const data = JSON.parse(text);
    const sig  = _arSig(data);

    if (sig === _arLastSig) { _arSucceed(); return; }

    _arEtag    = etag || _arEtag;
    _arLastSig = sig;
    globalData = data;
    renderAll();
    _arSucceed();

  } catch (e) {
    _arFailures++;
    console.warn('[auto-refresh]', e.message);
    if (_arFailures >= _AR_MAX_FAIL) {
      setIndicator('error');
      _arSchedule(_AR_POLL_MS[Math.min(_arFailures - _AR_MAX_FAIL + 1, 2)]);
    } else {
      setIndicator('idle');
      _arSchedule(_AR_POLL_MS[0]);
    }
  }
}

function _arSucceed() {
  _arFailures = 0;
  setIndicator('idle');
  _arSchedule(_AR_POLL_MS[0]);
}

async function _arFetch() {
  const hdrs = {};
  if (_arEtag) hdrs['If-None-Match'] = _arEtag;

  if (_arSource.type === 'url') {
    const res = await fetch(_arSource.url, { headers: hdrs });
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { text: await res.text(), etag: res.headers.get('ETag') };
  }

  // API / Database
  if (_arSource.type === 'api') {
    const { apiUrl, apiKey } = _arSource;
    const url = (apiUrl || '').replace(/\/$/, '') + '/api/sessions';
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}`, ...hdrs }
    });
    if (res.status === 304) return { notModified: true };
    if (res.status === 401) throw new Error('Invalid API key (401)');
    if (res.status === 403) throw new Error('Sem permissão (403)');
    if (res.status === 404) throw new Error('Endpoint não encontrado (404)');
    if (!res.ok) throw new Error('API error ' + res.status);
    return { text: await res.text(), etag: res.headers.get('ETag') };
  }

  // GitHub
  const { pat, repo, file } = _arSource;
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${file || 'sessions.json'}`;
  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github.v3.raw',
      'X-GitHub-Api-Version': '2022-11-28',
      ...hdrs,
    }
  });
  const rem = res.headers.get('X-RateLimit-Remaining');
  if (rem !== null) console.debug('[auto-refresh] GitHub rate limit remaining:', rem);
  if (res.status === 304) return { notModified: true };
  if (res.status === 401) throw new Error('Token inválido (401)');
  if (res.status === 403) throw new Error('Sem permissão (403)');
  if (res.status === 404) throw new Error('Não encontrado (404)');
  if (!res.ok) throw new Error('GitHub API ' + res.status);
  return { text: await res.text(), etag: res.headers.get('ETag') };
}

// ---- Change-detection signature ----
function _arSig(data) {
  if (!data || !data.sessions) return '';
  let maxAt = '';
  let count = 0;
  let nameSig = 0;
  for (const s of Object.values(data.sessions)) {
    if ((s.last_activity_at || '') > maxAt) maxAt = s.last_activity_at || '';
    count += (s.log || []).length;
    // A rename changes only session_name, so hash the names into the signature.
    const n = s.session_name || '';
    for (let i = 0; i < n.length; i++) nameSig = (nameSig * 31 + n.charCodeAt(i)) | 0;
    nameSig = (nameSig * 31 + 0x1f) | 0;
  }
  return maxAt + ':' + count + ':' + nameSig;
}

// ---- Visibility: pause on background, refetch on focus ----
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (_arTimer) { clearTimeout(_arTimer); _arTimer = null; }
    return;
  }
  if (!_arSource) return;
  const elapsed = Date.now() - _arLastAt;
  if (elapsed >= _AR_DEDUPE_MS) {
    _arDoFetch(); // immediate fetch; schedules next tick internally
  } else {
    _arSchedule(_AR_POLL_MS[0] - elapsed); // resume remainder of interval
  }
});

// ---- Indicator ----
function setIndicator(state) {
  const el = document.getElementById('refresh-indicator');
  if (!el) return;
  el.hidden    = (state === 'hidden');
  el.className = state === 'hidden' ? '' : 'ri-' + state;
  const txt = el.querySelector('.ri-text');
  if (!txt) return;
  const t = new Date().toLocaleTimeString(undefined,
    { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (state === 'loading') txt.textContent = 'Atualizando…';
  else if (state === 'error') txt.textContent = 'Falha ' + t;
  else if (state === 'idle')  txt.textContent = 'Atualizado \xe0s ' + t;
}
