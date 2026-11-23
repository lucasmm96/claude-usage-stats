// ---- Private repo: GitHub API fetch ----
async function fetchFromGitHub(pat, repo, filePath) {
  const path = filePath || 'sessions.json';
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github.v3.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  });
  if (res.status === 401) throw new Error('Invalid token (401 Unauthorized)');
  if (res.status === 403) throw new Error('Access denied (403 Forbidden) — check PAT permissions');
  if (res.status === 404) throw new Error('Repository or file not found (404)');
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  return res.text();
}

async function tryAutoLoad() {
  let pat, repo, file;
  try {
    pat  = localStorage.getItem(LS_PAT);
    repo = localStorage.getItem(LS_REPO);
    file = localStorage.getItem(LS_FILE) || 'sessions.json';
  } catch(e) { return; }
  if (!pat || !repo) return;
  updateGhButton(true);
  try {
    const text = await fetchFromGitHub(pat, repo, file);
    loadJson(text, { type: 'github', pat, repo, file });
  } catch(e) {
    updateGhButton(false);
    console.warn('Auto-load from private repo failed:', e.message);
  }
}

// ---- Modal ----
let _ghModalTrigger = null;
function openModal() {
  let pat = '', repo = '', file = '';
  try {
    pat  = localStorage.getItem(LS_PAT)  || '';
    repo = localStorage.getItem(LS_REPO) || '';
    file = localStorage.getItem(LS_FILE) || '';
  } catch(e) {}
  _ghModalTrigger = document.activeElement;
  document.getElementById('m-pat').value  = pat;
  document.getElementById('m-repo').value = repo;
  document.getElementById('m-file').value = file;
  document.getElementById('modal-status').textContent = '';
  document.getElementById('modal-status').className = '';
  document.getElementById('clear-btn').style.display = pat ? 'inline-flex' : 'none';
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('m-pat').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  // Return focus to whatever opened the dialog.
  if (_ghModalTrigger && document.contains(_ghModalTrigger)) _ghModalTrigger.focus();
  _ghModalTrigger = null;
}

function togglePat() {
  const el = document.getElementById('m-pat');
  const btn = document.getElementById('pat-toggle');
  if (el.type === 'password') { el.type = 'text'; btn.textContent = 'Hide'; }
  else { el.type = 'password'; btn.textContent = 'Show'; }
}

async function connectRepo() {
  const pat  = document.getElementById('m-pat').value.trim();
  const repo = document.getElementById('m-repo').value.trim();
  const file = document.getElementById('m-file').value.trim() || 'sessions.json';
  const statusEl = document.getElementById('modal-status');
  const btn = document.getElementById('connect-btn');

  if (!pat)  { setModalStatus('err', 'PAT is required.'); return; }
  if (!repo || !repo.includes('/')) { setModalStatus('err', 'Repository must be in owner/repo format.'); return; }

  btn.textContent = 'Connecting…';
  btn.disabled = true;
  setModalStatus('', '');

  try {
    const text = await fetchFromGitHub(pat, repo, file);
    // Save to localStorage only after successful fetch
    try {
      localStorage.setItem(LS_PAT,  pat);
      localStorage.setItem(LS_REPO, repo);
      localStorage.setItem(LS_FILE, file);
    } catch(e) {}
    setModalStatus('ok', `Connected to ${repo}`);
    document.getElementById('clear-btn').style.display = 'inline-flex';
    updateGhButton(true);
    loadJson(text, { type: 'github', pat, repo, file });
    setTimeout(closeModal, 800);
  } catch(e) {
    setModalStatus('err', e.message);
  } finally {
    btn.textContent = 'Connect';
    btn.disabled = false;
  }
}

function clearCredentials() {
  if (!confirm('Remove saved credentials from this browser?')) return;
  try {
    localStorage.removeItem(LS_PAT);
    localStorage.removeItem(LS_REPO);
    localStorage.removeItem(LS_FILE);
  } catch(e) {}
  document.getElementById('m-pat').value  = '';
  document.getElementById('m-repo').value = '';
  document.getElementById('m-file').value = '';
  document.getElementById('clear-btn').style.display = 'none';
  updateGhButton(false);
  setModalStatus('ok', 'Credentials cleared.');
}

function setModalStatus(type, msg) {
  const el = document.getElementById('modal-status');
  el.textContent = msg;
  el.className = type;
}

function updateGhButton(connected) {
  const btn = document.getElementById('gh-btn');
  if (connected) {
    btn.innerHTML = ICONS.lock + 'GitHub repo' + ICONS.check;
    btn.classList.add('btn-connected');
  } else {
    btn.innerHTML = ICONS.lock + 'GitHub repo';
    btn.classList.remove('btn-connected');
  }
}
