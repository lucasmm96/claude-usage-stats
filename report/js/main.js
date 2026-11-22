// ---- File loader ----
// Paint button labels with their icons before any auto-load runs.
updateGhButton(false);
updateApiButton(false);

document.getElementById('file-btn').onclick = () => document.getElementById('file-in').click();
document.getElementById('file-in').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => loadJson(ev.target.result);
  r.readAsText(f);
  e.target.value = '';
});

// ---- URL loader ----
document.getElementById('url-btn').onclick = fetchUrl;
document.getElementById('url-in').addEventListener('keydown', e => { if (e.key === 'Enter') fetchUrl(); });

// ---- Auto-load from ?data= param ----
(function() {
  const u = new URLSearchParams(location.search).get('data');
  if (u) { document.getElementById('url-in').value = u; fetchUrl(); return; }
  // GitHub takes precedence; fall back to API if GitHub not configured
  let hasPat = false;
  try { hasPat = !!localStorage.getItem(LS_PAT); } catch(e) {}
  if (hasPat) { tryAutoLoad(); } else { tryAutoLoadApi(); }
})();

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});
document.getElementById('api-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('api-modal-overlay')) closeApiModal();
});
document.getElementById('daily-modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('daily-modal-overlay')) closeDailyModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closePricingModal(); closeApiModal(); closeDailyModal(); }
});

// Focus trap inside every dialog: Tab cycles within the open modal only.
function attachFocusTrap(overlay) {
  overlay.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || !overlay.classList.contains('open')) return;
    const modal = overlay.querySelector('.modal');
    if (!modal) return;
    const focusable = Array.from(modal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
    )).filter(el => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });
}
['modal-overlay', 'api-modal-overlay', 'pricing-modal-overlay', 'daily-modal-overlay'].forEach(id => {
  const overlay = document.getElementById(id);
  if (overlay) attachFocusTrap(overlay);
});
