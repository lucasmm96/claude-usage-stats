// ==== Portkey auto-pricing (v2) ====
// Reads/writes same localStorage as pricing.js: 'claude_usage_stats_pricing'
// Depends on global getPricingData()/savePricingData() from pricing.js being loaded first.

const PORTKEY_TTL_MS = 24 * 60 * 60 * 1000;   // 24h bulk JSON cache
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6h sync interval
const MAX_HISTORY = 50;
const PORTKEY_CACHE_KEY = 'claude_usage_stats_portkey_cache';

// Aggregate provider used as last-resort fallback when the primary guess misses.
const PORTKEY_AGGREGATE = 'openrouter';

let _syncing = false;
let _syncTimer = null;

// ---- tiny wrappers (avoid ordering dependency) ----
function _getPricingData() {
  return typeof getPricingData === 'function' ? getPricingData() : null;
}
function _savePricingData(data) {
  if (typeof savePricingData === 'function') savePricingData(data);
}

// ---- Provider bulk fetch ----
const PORTKEY_PROVIDER_URL = provider => `https://configs.portkey.ai/pricing/${provider}.json`;

async function fetchProviderJson(provider) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(PORTKEY_CACHE_KEY) || '{}'); } catch(e) {}
  const cached = cache[provider];
  if (cached && Date.now() - cached.at < PORTKEY_TTL_MS) return cached.data;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(PORTKEY_PROVIDER_URL(provider), {headers: {'Accept': 'application/json'}, signal: ctrl.signal});
    if (!res.ok) return null;
    const data = await res.json();
    cache[provider] = {data, at: Date.now()};
    try { localStorage.setItem(PORTKEY_CACHE_KEY, JSON.stringify(cache)); } catch(e) {}
    return data;
  } catch(e) {
    console.warn('[portkey] bulk fetch failed for', provider, e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Model pricing lookup from bulk data ----
// Exact key match, then normalized exact, then normalized containment
// (e.g. "claude-sonnet-4-6" vs "claude-sonnet-4-6-20261101"); longest match wins.
function lookupModelPricing(bulkData, modelName) {
  if (!bulkData) return null;
  let entry = bulkData[modelName];
  if (!entry) {
    const nk = normKey(modelName);
    if (nk) {
      for (const k of Object.keys(bulkData)) {
        if (normKey(k) === nk) { entry = bulkData[k]; break; }
      }
      if (!entry) {
        // Fuzzy: pick the longest key whose normalized form matches the name,
        // either by whole-string containment (>=6 chars) or by token containment
        // (every >=3-char word of the raw name appears in the key). "free" names
        // must resolve to ":free" variants so a Free model never gets a paid price.
        // Note: tokens come from the RAW lowercase name (not normKey), because
        // normKey collapses separators and merges words ("nvidia nemotron" →
        // "nvidianemotron"), which breaks token matching.
        const nameFree = /free/.test(nk);
        const nameTok = (String(modelName).toLowerCase().match(/[a-z]{3,}|\d{3,}/g) || [])
          .filter(t => t.length >= 3);
        let best = null, bestLen = 0;
        for (const k of Object.keys(bulkData)) {
          const n = normKey(k);
          if (!n) continue;
          if (nameFree && !/free/.test(n)) continue;
          const shorter = n.length < nk.length ? n : nk;
          const longer  = n.length < nk.length ? nk : n;
          const ok = (shorter.length >= 6 && longer.includes(shorter)) ||
                     (nameTok.length >= 2 && nameTok.every(t => n.includes(t)));
          if (ok && n.length > bestLen) { best = bulkData[k]; bestLen = n.length; }
        }
        entry = best;
      }
    }
  }
  if (!entry) return null;
  const config = entry?.pricing_config?.pay_as_you_go;
  if (!config) return null;
  return {
    key: Object.keys(bulkData).find(k => bulkData[k] === entry),
    values: {
      input:      config.request_token?.price ?? null,
      output:     config.response_token?.price ?? null,
      cacheRead:  config.cache_read_input_token?.price ?? null,
      cacheWrite: config.cache_write_input_token?.price ?? null,
    }
  };
}

// ---- Slug resolution (strip :free/:beta/:nitro, extract provider/model) ----
function resolveSlug(slug) {
  if (!slug) return null;
  let clean = slug.replace(/:free|:beta|:nitro$/, '');
  const parts = clean.split('/');
  return { provider: (parts[0] || '').toLowerCase(), modelName: parts.slice(1).join('/') || '' };
}

// ---- Commercial name → provider hint ----
// Keywords matched longest-first against the lowercased commercial name.
// Covers common families; 'openrouter' aggregate is tried as a final fallback regardless.
const PROVIDER_HINTS = [
  ['claude', 'anthropic'], ['anthropic', 'anthropic'], ['sonnet', 'anthropic'],
  ['opus', 'anthropic'], ['haiku', 'anthropic'], ['fable', 'anthropic'],
  ['openai', 'openai'], ['gpt', 'openai'], ['o1-', 'openai'], ['o3-mini', 'openai'],
  ['codex', 'openai'], ['davinci', 'openai'],
  ['gemini', 'google'], ['google', 'google'],
  ['deepseek', 'deepseek'], ['grok', 'xai'], ['xai', 'xai'],
  ['llama', 'meta'], ['meta', 'meta'],
  ['nemotron', 'nvidia'], ['nvidia', 'nvidia'],
  ['mistral', 'mistral'], ['mixtral', 'mistral'], ['codestral', 'mistral'],
  ['qwen', 'qwen'], ['kimi', 'moonshot'], ['moonshot', 'moonshot'],
  ['perplexity', 'perplexity'], ['sonar', 'perplexity'],
  ['cohere', 'cohere'], ['command r', 'cohere'], ['command-r', 'cohere'],
  ['dbrx', 'databricks'], ['databricks', 'databricks'],
  ['nova', 'amazon'], ['amazon', 'amazon'],
];
function hintProvider(name) {
  if (!name) return null;
  const low = name.toLowerCase();
  for (const [kw, provider] of PROVIDER_HINTS) {
    if (kw.length <= low.length && low.includes(kw)) return provider;
  }
  return null;
}

// ---- Cents per token → $/MTok (API returns cents/token; $/MTok = cents * 1e4) ----
function centsToMtok(c) {
  if (typeof c !== 'number' || !isFinite(c)) return null;
  return Number((c * 1e4).toFixed(4));
}

// ---- Collect resolution candidates for a commercial model name ----
// Returns [{provider, modelKey}] in priority order, deduplicated.
function candidatesFor(commName, slug) {
  const out = [];
  const seen = new Set();
  const add = (provider, modelKey) => {
    if (!provider || !modelKey || seen.has(provider + '|' + modelKey)) return;
    seen.add(provider + '|' + modelKey);
    out.push({ provider, modelKey });
  };
  const sl = slug ? resolveSlug(slug) : null;
  if (sl) add(sl.provider, sl.modelName);        // 1: exact slug (best)
  const hint = hintProvider(commName);
  if (hint) add(hint, commName);                  // 2: guessed provider (name is the slug)
  add(PORTKEY_AGGREGATE, commName);               // 3: aggregate fallback
  return out;
}

// ---- Main sync engine ----
async function syncPrices(sessions) {
  if (_syncing) return;
  _syncing = true;

  // 1. Collect model targets: session model + every entry model (multi-model sessions)
  const targets = [];
  const seenNames = new Set();
  for (const sess of Object.values(sessions || {})) {
    if (!sess) continue;
    const slug = (sess._state && sess._state.real_model) || null;
    const names = [sess.model || ''];
    for (const e of (Array.isArray(sess.log) ? sess.log : [])) {
      if (!e.event && e.model) names.push(e.model);
    }
    for (const commName of names) {
      if (!commName || seenNames.has(commName)) continue;
      seenNames.add(commName);
      targets.push({ commName, slug });
    }
  }

  // 2. Sync each target through its candidate providers
  const data = _getPricingData();
  if (!data) { _syncing = false; return; }
  let changed = false;

  for (const t of targets) {
    const cands = candidatesFor(t.commName, t.slug);
    let found = null, usedCand = null;
    for (const c of cands) {
      const bulk = await fetchProviderJson(c.provider);
      if (!bulk) continue;
      const pricing = lookupModelPricing(bulk, c.modelKey);
      if (pricing !== null) { found = pricing; usedCand = c; break; }
    }

    if (!found) {
      // not found anywhere → mark autoFailed (existing entries), keep values
      const existing = data.prices[t.commName];
      if (existing) {
        existing.autoFailed = true;
        existing.lastAttemptAt = new Date().toISOString();
        changed = true;
      }
      _savePricingData(data);
      continue;
    }

    const v = found.values;
    const mtInput = centsToMtok(v.input) ?? 0;
    const mtOutput = centsToMtok(v.output) ?? 0;
    const mtCacheR = centsToMtok(v.cacheRead) ?? 0;
    const mtCacheW = centsToMtok(v.cacheWrite) ?? 0;
    const matchedKey = found.key || usedCand.modelKey;
    const portkeyId = `${usedCand.provider}/${matchedKey}`;
    const nowISO = new Date().toISOString();

    if (!data.prices[t.commName]) {
      // new entry
      data.prices[t.commName] = {
        input: mtInput, output: mtOutput, cacheRead: mtCacheR, cacheWrite: mtCacheW,
        source: 'portkey',
        portkeyId,
        syncAt: nowISO,
        lastAttemptAt: null,
        autoFailed: false,
        history: [{ at: nowISO, input: mtInput, cacheRead: mtCacheR, cacheWrite: mtCacheW, output: mtOutput, source: 'portkey' }]
      };
      changed = true;
      _savePricingData(data);
      continue;
    }

    const existing = data.prices[t.commName];
    // manual prices are never overwritten — only refresh metadata
    if (existing.source === 'manual') {
      if (existing.autoFailed) existing.autoFailed = false;
      existing.lastAttemptAt = existing.lastAttemptAt || nowISO;
      existing.syncAt = nowISO;
      existing.portkeyId = portkeyId;
      _savePricingData(data);
      continue;
    }

    const valueChanged = existing.input !== mtInput || existing.output !== mtOutput ||
                         existing.cacheRead !== mtCacheR || existing.cacheWrite !== mtCacheW;
    if (valueChanged) {
      existing.history = existing.history || [];
      if (existing.history.length >= MAX_HISTORY) existing.history = existing.history.slice(-MAX_HISTORY + 1);
      existing.history.push({
        at: nowISO,
        input: existing.input, cacheRead: existing.cacheRead, cacheWrite: existing.cacheWrite, output: existing.output,
        source: existing.source || 'portkey'
      });
      existing.input = mtInput; existing.output = mtOutput;
      existing.cacheRead = mtCacheR; existing.cacheWrite = mtCacheW;
      changed = true;
    }
    existing.syncAt = nowISO;
    existing.portkeyId = portkeyId;
    existing.autoFailed = false;
    if (existing.source !== 'portkey') existing.source = 'portkey';
    _savePricingData(data);
  }

  _syncing = false;
  // Re-render so freshly auto-populated prices reflect immediately
  if (changed && typeof renderAll === 'function' && typeof globalData !== 'undefined' && globalData) {
    renderAll();
    if (typeof updatePricingButton === 'function') updatePricingButton();
  }
  scheduleSync();
}

// ---- Scheduler ----
function scheduleSync() {
  if (_syncTimer) clearTimeout(_syncTimer);
  const jitter = Math.floor(Math.random() * 15 * 60 * 1000); // 0-15min jitter
  const delay = SYNC_INTERVAL_MS + jitter;
  _syncTimer = setTimeout(() => {
    if (globalData && globalData.sessions) syncPrices(globalData.sessions);
    scheduleSync(); // reschedule after fire
  }, delay);
}

// ---- Kickoff after data load ----
function kickoffSync() {
  if (globalData && globalData.sessions) {
    syncPrices(globalData.sessions);
  }
}

// ---- Badge CSS injection (run once on load) ----
(function () {
  if (document.getElementById('portkey-badge-style')) return;
  const style = document.createElement('style');
  style.id = 'portkey-badge-style';
  style.textContent = `
    .price-meta { font-size: 10px; color: var(--muted); margin-left: 4px; }
  `;
  document.head.appendChild(style);
})();