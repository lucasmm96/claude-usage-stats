// ---- URL loader ----
function fetchUrl() {
  const url = document.getElementById('url-in').value.trim();
  if (!url) return;
  fetch(url)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(text => loadJson(text, { type: 'url', url }))
    .catch(err => alert('Failed to load: ' + err.message));
}

// ---- JSON ingestion ----
function loadJson(text, source) {
  try {
    const d = JSON.parse(text);
    if (!d.sessions) throw new Error('Missing "sessions" key');
    globalData = d;
    stopAutoRefresh();
    renderAll();
    kickoffSync();
    if (source && (source.type === 'url' || source.type === 'github' || source.type === 'api')) {
      startAutoRefresh(source);
    }
  } catch(e) {
    alert('Invalid JSON: ' + e.message);
  }
}
