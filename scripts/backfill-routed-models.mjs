#!/usr/bin/env node
// One-shot backfill: replaces router-alias model names ("openrouter/free",
// "openrouter/auto") on already-logged entries with the model that actually
// answered. Entries are matched to assistant messages in the session transcript
// (~/.claude/projects/<dir>/<session_id>.jsonl) by exact token-usage equality
// (input/cache_read/cache_write/output) plus a timestamp window.
//
// Phase 1 — local log file (scripts/claude-usage-stats-log.json lives in the
//   installed script dir, ~/.claude/claude-usage-stats/ by default).
// Phase 2 — re-POST the affected sessions to /api/ingest (the DB is a derived
//   upsert copy; the ingest conflict path updates `model` only, so re-sending
//   the corrected sessions propagates the fix idempotently).
// Phase 3 — reconcile: fetch /api/sessions and verify the corrected entries'
//   models match the file exactly.
//
// Usage:
//   node scripts/backfill-routed-models.mjs                 # dry-run: diff only
//   node scripts/backfill-routed-models.mjs --apply         # backup + log + POST + reconcile
//   node scripts/backfill-routed-models.mjs --apply --no-post
//
// Env: API_URL (default https://claude-usage-stats.vercel.app), API_KEY.
// Zero dependencies: node >= 18 (global fetch).

import { readFileSync, writeFileSync, cpSync, readdirSync, statSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const ROUTER_ALIASES = new Set(['openrouter/free', 'openrouter/auto']);
const MATCH_WINDOW_MS = parseInt(process.argv.find(a => a.startsWith('--window='))?.split('=')[1] || '120000', 10);

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const noPost = args.has('--no-post');

const HOME = homedir();
const LOG_FILE = (() => {
  const i = process.argv.indexOf('--log');
  return i > -1 ? process.argv[i + 1] : join(HOME, '.claude', 'claude-usage-stats', 'claude-usage-stats-log.json');
})();
const PROJECTS_DIR = (() => {
  const i = process.argv.indexOf('--projects');
  return i > -1 ? process.argv[i + 1] : join(HOME, '.claude', 'projects');
})();
const CACHE_FILE = join(dirname(LOG_FILE), 'models-cache.json');
const API_URL = process.env.API_URL || 'https://claude-usage-stats.vercel.app';
const API_KEY = process.env.API_KEY;

// ---- serialize against concurrent hook runs (mirror of the hook's mkdir lock) ----
const LOG_LOCK = LOG_FILE + '.lock.d';
function acquireLock() {
  for (let i = 0; i < 120; i++) {
    try {
      mkdirSync(LOG_LOCK);
      return () => { try { rmdirSync(LOG_LOCK); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(LOG_LOCK).mtimeMs > 10000) rmdirSync(LOG_LOCK);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return () => {}; // lock busy >6s: proceed unlocked (the hook itself gives up after 3s)
}

// ---- name resolution (mirrors scripts/claude-usage-stats.sh) ----
function heuristicName(slug) {
  const base = (slug.split('/')[1] || slug).replace(/:[^:]+$/, '');
  return base.split('-').map(w => /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)).join(' ');
}
function applyFreeSuffix(name, isFree) {
  const cleaned = name.replace(/[\s(:]+free[)\s]*$/i, '').trimEnd();
  return isFree ? cleaned + ' (Free)' : cleaned;
}
const cacheMap = (() => {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')).models || {}; } catch { return {}; }
})();
function resolveName(slug) {
  return applyFreeSuffix(cacheMap[slug] || heuristicName(slug), slug.endsWith(':free'));
}

// ---- transcript access ----
function findTranscript(sessionId) {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const dir of readdirSync(PROJECTS_DIR)) {
    const f = join(PROJECTS_DIR, dir, sessionId + '.jsonl');
    try { if (statSync(f).isFile()) return f; } catch {}
  }
  return null;
}
function collectMessages(transcriptPath) {
  const out = [];
  for (const line of readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'assistant' || !e.message?.usage || !e.message.model) continue;
    if (e.message.model === '<synthetic>') continue;
    const u = e.message.usage;
    if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') continue;
    out.push({
      ts: Date.parse(e.timestamp) || 0,
      model: e.message.model,
      u: [u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.output_tokens],
    });
  }
  return out;
}

// ---- matching ----
function usageKey(e) {
  return [e.input_tokens ?? 0, e.cache_read_tokens ?? 0, e.cache_write_tokens ?? 0, e.output_tokens ?? 0].join('|');
}
function matchEntry(entry, msgs) {
  const key = usageKey(entry);
  const at = Date.parse(entry.at);
  const hits = msgs.filter(m => m.u.join('|') === key && Math.abs(m.ts - at) <= MATCH_WINDOW_MS);
  if (hits.length === 0) return { ok: false, reason: 'unmatched' };
  const models = new Set(hits.map(h => h.model));
  if (models.size > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, slug: [...models][0] };
}

// ---- main ----
const release = acquireLock();
let data;
try {
  data = JSON.parse(readFileSync(LOG_FILE, 'utf8'));
} catch (e) {
  release();
  throw e;
}
const changes = [];       // { sessionId, at, old, new }
const lastSlug = {};      // sessionId -> slug of its last matched exchange
const stats = { sessions: 0, entries: 0, matched: 0, ambiguous: 0, unmatched: 0, noTranscript: 0 };

for (const [sessionId, sess] of Object.entries(data.sessions || {})) {
  const aliasEntries = (sess.log || []).filter(e => !e.event && ROUTER_ALIASES.has(e.model));
  if (aliasEntries.length === 0) continue;
  stats.sessions++;
  stats.entries += aliasEntries.length;

  const transcriptPath = findTranscript(sessionId);
  if (!transcriptPath) { stats.noTranscript += aliasEntries.length; continue; }
  const msgs = collectMessages(transcriptPath);

  for (const e of aliasEntries) {
    const m = matchEntry(e, msgs);
    if (!m.ok) { stats[m.reason]++; continue; }
    stats.matched++;
    changes.push({ sessionId, at: e.at, old: e.model, new: resolveName(m.slug), slug: m.slug });
    lastSlug[sessionId] = m.slug;
  }
}

// The session-level `model` may still name the router alias: it is derived from
// _state.real_model, which router sessions leave null (payload-only). Fix it
// from the session's last non-alias entry (the last exchange's model after the
// entry backfill above) — deterministic and conservative: no concrete model,
// no fix.
const sessionFixes = [];
for (const [sessionId, sess] of Object.entries(data.sessions || {})) {
  if (!sess || !ROUTER_ALIASES.has(sess.model)) continue;
  const lastConcrete = [...(sess.log || [])].reverse()
    .find(e => !e.event && e.model && !ROUTER_ALIASES.has(e.model));
  if (lastConcrete && lastConcrete.model !== sess.model) {
    sessionFixes.push({ sessionId, old: sess.model, new: lastConcrete.model });
  }
}

const affectedSessions = new Set([
  ...changes.map(c => c.sessionId),
  ...sessionFixes.map(f => f.sessionId),
]);
console.log(`sessions with router entries : ${stats.sessions}`);
console.log(`router entries total         : ${stats.entries}`);
console.log(`  matched (will fix)         : ${stats.matched}`);
console.log(`  ambiguous (skipped)        : ${stats.ambiguous}`);
console.log(`  unmatched (skipped)        : ${stats.unmatched}`);
console.log(`  no transcript (skipped)    : ${stats.noTranscript}`);
console.log(`session model fixes          : ${sessionFixes.length}`);

if (changes.length === 0 && sessionFixes.length === 0) {
  console.log('\nNothing to backfill (no router-alias entries or session models left — run twice is a no-op).');
  release();
  process.exit(0);
}

console.log('\nSample of changes:');
for (const c of changes.slice(0, 10)) {
  console.log(`  ${c.sessionId.slice(0, 8)}  ${c.at}  ${c.old}  ->  ${c.new}  (${c.slug})`);
}
if (changes.length > 10) console.log(`  ... and ${changes.length - 10} more`);
for (const f of sessionFixes) {
  console.log(`  [session]  ${f.sessionId.slice(0, 8)}  model  ${f.old}  ->  ${f.new}`);
}

if (!apply) {
  console.log('\nDry-run: nothing changed. Re-run with --apply to write the log and re-sync the DB.');
  release();
  process.exit(0);
}

// ---- phase 1: backup + write ----
const backup = LOG_FILE + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
cpSync(LOG_FILE, backup);
console.log(`\nBackup: ${backup}`);

for (const c of changes) {
  const sess = data.sessions[c.sessionId];
  const e = (sess.log || []).find(x => !x.event && x.at === c.at);
  if (e && ROUTER_ALIASES.has(e.model)) e.model = c.new;
}
for (const f of sessionFixes) {
  if (data.sessions[f.sessionId] && ROUTER_ALIASES.has(data.sessions[f.sessionId].model)) {
    data.sessions[f.sessionId].model = f.new;
  }
}
writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
console.log(`Log updated: ${changes.length} entries rewritten + ${sessionFixes.length} session models fixed (${affectedSessions.size} sessions).`);
release();

if (noPost) { console.log('Skipped DB sync (--no-post).'); process.exit(0); }

// ---- phase 2: POST affected sessions ----
if (!API_KEY) { console.error('API_KEY env var required for DB sync. Re-run with --no-post to skip.'); process.exit(1); }
const sessions = Object.fromEntries([...affectedSessions].map(id => [id, data.sessions[id]]));
console.log(`POSTing ${Object.keys(sessions).length} sessions to ${API_URL}/api/ingest ...`);
const res = await fetch(`${API_URL}/api/ingest`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessions }),
});
const body = await res.json();
if (!res.ok) { console.error(`POST failed (${res.status}):`, body); process.exit(1); }
console.log(`  ok (sessions_upserted: ${body.sessions_upserted}, log_entries: ${body.log_entries_inserted})`);

// ---- phase 3: reconcile ----
console.log('Reconciling against /api/sessions ...');
const readRes = await fetch(`${API_URL}/api/sessions`, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
if (!readRes.ok) { console.error(`GET /api/sessions failed (${readRes.status})`); process.exit(1); }
const remote = (await readRes.json()).sessions || {};
let mismatches = 0, checked = 0;
for (const [id, sess] of Object.entries(sessions)) {
  const r = remote[id];
  if (!r) { console.error(`  session ${id.slice(0, 8)}: MISSING in DB`); mismatches++; continue; }
  const rLog = (r.log || []).filter(x => !x.event);
  if (rLog.length > (sess.log || []).length) {
    // Upsert never deletes: the DB may legitimately hold entries that were
    // removed from the local file (e.g. after a manual restore). Informational.
    console.log(`  ${id.slice(0, 8)}: DB has ${rLog.length - (sess.log || []).length} extra entries not in the file (kept).`);
  }
  if (r.model !== sess.model) {
    console.error(`  ${id.slice(0, 8)}: DB session model ${JSON.stringify(r.model)} != file ${JSON.stringify(sess.model)}`);
    mismatches++;
  }
  for (const e of sess.log || []) {
    if (e.event || e.at === undefined) continue;
    const re = rLog.find(x => Date.parse(x.at) === Date.parse(e.at));
    checked++;
    if (!re || re.model !== e.model) {
      console.error(`  ${id.slice(0, 8)} ${e.at}: DB model ${re ? JSON.stringify(re.model) : 'absent'} != file ${JSON.stringify(e.model)}`);
      mismatches++;
    }
  }
}
if (mismatches > 0) { console.error(`RECONCILE FAILED: ${mismatches} mismatches of ${checked} entries checked.`); process.exit(1); }
console.log(`Reconcile PASS: ${checked} entries match between log and DB (file entries ⊆ DB).`);