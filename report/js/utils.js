// ---- Helpers ----
function fmtN(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function fmtDt(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDur(a, b) {
  const m = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function dedupe(log) {
  const out = [];
  for (const e of log) {
    if (e.event) { out.push(e); continue; }
    const prev = [...out].reverse().find(x => !x.event);
    if (prev &&
        prev.input_tokens === e.input_tokens &&
        prev.cache_read_tokens === e.cache_read_tokens &&
        prev.cache_write_tokens === e.cache_write_tokens &&
        prev.output_tokens === e.output_tokens) continue;
    out.push(e);
  }
  return out;
}
function fmtDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleString(undefined, { month: 'short', day: 'numeric' });
}
function getFilteredSessions() {
  if (!globalData) return [];
  let sessions = Object.values(globalData.sessions);
  if (activeProfile) {
    sessions = activeProfile === '__other__'
      ? sessions.filter(s => !s.profile)
      : sessions.filter(s => s.profile === activeProfile);
  }
  if (activeModels.size > 0) {
    sessions = sessions.filter(s =>
      s.model && activeModels.has(s.model) ||
      (s.log || []).some(e => !e.event && e.model && activeModels.has(e.model))
    );
  }
  return sessions;
}

// Resolve a price entry for a model key. Exact match first, then a normalized
// match (case/punctuation-insensitive), then a normalized containment match.
// Containment only applies when the shorter key has >= 10 alphanumerics.
// Optional timestamp: if provided, checks history for price valid at that time.
function findPrice(key, pricing, timestamp) {
  if (!key || !pricing || !pricing.prices) return null;
  const entry = pricing.prices[key];
  if (entry !== undefined) {
    // If timestamp provided, check history for price at that point
    if (timestamp && entry.history && entry.history.length > 0) {
      const past = entry.history.filter(h => h.at <= timestamp);
      if (past.length > 0) {
        const h = past[past.length - 1];
        return { input: h.input, cacheRead: h.cacheRead, cacheWrite: h.cacheWrite, output: h.output };
      }
    }
    return entry;
  }
  const nk = normKey(key);
  if (!nk) return null;
  let best = null, bestLen = 0;
  for (const [k, v] of Object.entries(pricing.prices)) {
    const n = normKey(k);
    if (!n) continue;
    if (n === nk) return v;
    const shorter = n.length < nk.length ? n : nk;
    const longer  = n.length < nk.length ? nk : n;
    if (shorter.length >= 10 && longer.includes(shorter) && n.length > bestLen) {
      best = v;
      bestLen = n.length;
    }
  }
  return best;
}

// Returns the pricing entry for a log entry, using entry.model with fallback to sessModel.
// Optional timestamp for retroactive pricing (history lookup).
function entryModelPrice(entry, sessModel, pricing, timestamp) {
  const key = entry.model || sessModel || '';
  return findPrice(key, pricing, timestamp) || pricing._default;
}

function isInDateRange(isoDate) {
  if (!isoDate) return true;
  const r = activeRange;
  if (!r || r === 0 || r === '0') return true;
  const day = localDateStr(isoDate);
  if (r === 'custom') {
    if (!currentDateFrom || !currentDateTo) return true;
    return day >= currentDateFrom && day <= currentDateTo;
  }
  if (r === 'month') {
    const today = new Date();
    const cutoff = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`;
    return day >= cutoff;
  }
  const n = Number(r);
  if (n > 0) {
    const today = new Date();
    const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1));
    return day >= localDateStr(cutoff);
  }
  return true;
}

function sessStats(sess) {
  const log = dedupe(sess.log || []);
  const exch = log.filter(e => !e.event);
  const compacts = log.filter(e => e.event === 'compact').length;
  const total = exch.reduce((s, e) => s + e.input_tokens + e.cache_read_tokens + e.cache_write_tokens + e.output_tokens, 0);
  const cr = exch.reduce((s, e) => s + e.cache_read_tokens, 0);
  const totalIn = exch.reduce((s, e) => s + e.input_tokens + e.cache_read_tokens + e.cache_write_tokens, 0);
  const cacheHit = totalIn > 0 ? cr / totalIn * 100 : 0;
  return { log, exch, compacts, total, cacheHit };
}
