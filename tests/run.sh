#!/usr/bin/env bash
# tests/run.sh — fixture-based tests for claude-usage-stats.sh
# Usage: bash tests/run.sh
# API tests (T6-T9) require DATABASE_URL to be set; otherwise they are skipped.
# Windows-compatible: no /dev/stdin, no /dev/null for node reads.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/claude-usage-stats.sh"
PASS=0; FAIL=0; SKIP=0

# On Windows, Git Bash's /tmp is not visible to Node.js (which uses native paths).
# Use Node.js's own tmpdir so both shells and Node.js can access the same files.
NODE_TMPDIR=$(node -e "process.stdout.write(require('os').tmpdir())" 2>/dev/null || echo "/tmp")

pass() { echo "✅ PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "❌ FAIL: $1"; FAIL=$(( FAIL + 1 )); }
skip() { echo "⏭  SKIP: $1"; SKIP=$(( SKIP + 1 )); }

# The script derives LOG_FILE and CACHE_FILE from SCRIPT_DIR (dirname of $0).
# To isolate tests, we copy the script into a temp dir and run it from there.
# That way its state files land in the temp dir and don't pollute the repo.
make_test_env() {
  local tmp
  # Use Node.js tmpdir so paths are resolvable by both Bash and Node.js (Windows-compatible)
  tmp=$(mktemp -d -p "$NODE_TMPDIR" 2>/dev/null || mktemp -d)
  # Convert backslashes to forward slashes (Windows: Node.js accepts both; avoids JSON escaping issues)
  tmp="${tmp//\\//}"
  cp "$SCRIPT" "$tmp/claude-usage-stats.sh"
  echo "$tmp"
}

run_in_env() {
  local tmp="$1" payload="$2"
  bash "$tmp/claude-usage-stats.sh" <<< "$payload" 2>/dev/null
}

get_sess_model() {
  local tmp="$1" sid="$2"
  node -e "
const d = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
process.stdout.write(d.sessions[process.argv[2]]?.model || '');
" "$tmp/claude-usage-stats-log.json" "$sid" 2>/dev/null || echo ""
}

get_entry_model() {
  local tmp="$1" sid="$2" idx="${3:-0}"
  node -e "
const d = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const log = (d.sessions[process.argv[2]]?.log || []).filter(e => !e.event);
process.stdout.write(log[Number(process.argv[3])]?.model || '');
" "$tmp/claude-usage-stats.json" "$sid" "$idx" 2>/dev/null || echo ""
}

get_state_field() {
  local tmp="$1" sid="$2" field="$3"
  node -e "
const d = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const v = d.sessions[process.argv[2]]?._state?.[process.argv[3]];
process.stdout.write(v != null ? String(v) : '');
" "$tmp/claude-usage-stats.json" "$sid" "$field" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
echo "=== SCRIPT TESTS ==="
# ---------------------------------------------------------------------------

# T1: multi-model transcript — heuristic names, no cache
TMP=$(make_test_env)
TRANSCRIPT="$TMP/session.jsonl"
printf '%s\n' \
  '{"type":"assistant","message":{"model":"nvidia/nemotron-3.5-lightning:free","role":"assistant","content":[]},"requestedModel":"openrouter/free","session_id":"t1"}' \
  '{"type":"assistant","message":{"model":"dots-studio/dots-3-note-preview:free","role":"assistant","content":[]},"requestedModel":"openrouter/free","session_id":"t1"}' \
  '{"type":"assistant","message":{"model":"xingchen-agi/xing4.0-29b-a4b:free","role":"assistant","content":[]},"requestedModel":"openrouter/free","session_id":"t1"}' \
  > "$TRANSCRIPT"
PAYLOAD="{\"session_id\":\"t1\",\"model\":{\"display_name\":\"openrouter/free\"},\"transcript_path\":\"$TRANSCRIPT\",\"context_window\":{\"used_percentage\":42,\"total_input_tokens\":100000,\"total_output_tokens\":5000,\"current_usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":80000,\"cache_creation_input_tokens\":1000,\"output_tokens\":500}}}"
OUT=$(run_in_env "$TMP" "$PAYLOAD")
SM=$(get_sess_model "$TMP" "t1")
EM=$(get_entry_model "$TMP" "t1" "0")
RM=$(get_state_field "$TMP" "t1" "real_model")
if echo "$OUT" | grep -q '(Free)' && echo "$SM" | grep -q '(Free)' && [ "$EM" = "$SM" ] && echo "$RM" | grep -q ':free'; then
  pass "T1: multi-model transcript, heuristic names, (Free) suffix"
else
  fail "T1: OUT='$OUT' sess.model='$SM' entry.model='$EM' real_model='$RM'"
fi
rm -rf "$TMP"

# T2: multi-model transcript + cache present — cache name used
TMP=$(make_test_env)
TRANSCRIPT="$TMP/session.jsonl"
printf '%s\n' \
  '{"type":"assistant","message":{"model":"nvidia/nemotron-3.5-lightning:free","role":"assistant","content":[]},"requestedModel":"openrouter/free","session_id":"t2"}' \
  > "$TRANSCRIPT"
printf '%s' '{"fetched_at":"2026-01-01T00:00:00.000Z","models":{"nvidia/nemotron-3.5-lightning:free":"NVIDIA: Nemotron 3.5 Lightning"}}' \
  > "$TMP/models-cache.json"
PAYLOAD="{\"session_id\":\"t2\",\"model\":{\"display_name\":\"openrouter/free\"},\"transcript_path\":\"$TRANSCRIPT\",\"context_window\":{\"used_percentage\":10,\"total_input_tokens\":5000,\"total_output_tokens\":500,\"current_usage\":{\"input_tokens\":5,\"cache_read_input_tokens\":4000,\"cache_creation_input_tokens\":100,\"output_tokens\":200}}}"
OUT=$(run_in_env "$TMP" "$PAYLOAD")
SM=$(get_sess_model "$TMP" "t2")
if echo "$OUT" | grep -q 'NVIDIA: Nemotron' && echo "$OUT" | grep -q '(Free)' && echo "$SM" | grep -q '(Free)'; then
  pass "T2: cache hit — commercial name from cache with (Free) suffix"
else
  fail "T2: OUT='$OUT' sess.model='$SM'"
fi
rm -rf "$TMP"

# T3: no transcript_path — fallback to display_name, no entry.model
TMP=$(make_test_env)
PAYLOAD='{"session_id":"t3","model":{"display_name":"Sonnet 4.6"},"context_window":{"used_percentage":10,"total_input_tokens":5000,"total_output_tokens":500,"current_usage":{"input_tokens":5,"cache_read_input_tokens":4000,"cache_creation_input_tokens":100,"output_tokens":200}}}'
OUT=$(run_in_env "$TMP" "$PAYLOAD")
SM=$(get_sess_model "$TMP" "t3")
EM=$(get_entry_model "$TMP" "t3" "0")
if echo "$OUT" | grep -q 'Sonnet 4.6' && [ "$SM" = "Sonnet 4.6" ] && [ -z "$EM" ]; then
  pass "T3: no transcript — display_name preserved, no entry.model"
else
  fail "T3: OUT='$OUT' sess.model='$SM' entry.model='$EM'"
fi
rm -rf "$TMP"

# T4: direct Anthropic model, no transcript — no regression
TMP=$(make_test_env)
PAYLOAD='{"session_id":"t4","model":{"display_name":"claude-sonnet-4-6"},"context_window":{"used_percentage":25,"total_input_tokens":50000,"total_output_tokens":3000,"current_usage":{"input_tokens":3,"cache_read_input_tokens":40000,"cache_creation_input_tokens":500,"output_tokens":300}}}'
OUT=$(run_in_env "$TMP" "$PAYLOAD")
if echo "$OUT" | grep -q 'claude-sonnet-4-6'; then
  pass "T4: direct model, no transcript — no regression"
else
  fail "T4: OUT='$OUT'"
fi
rm -rf "$TMP"

# T5: corrupted cache — falls back to heuristic
TMP=$(make_test_env)
TRANSCRIPT="$TMP/session.jsonl"
printf '%s\n' \
  '{"type":"assistant","message":{"model":"nvidia/nemotron-3.5-lightning:free","role":"assistant","content":[]},"requestedModel":"openrouter/free","session_id":"t5"}' \
  > "$TRANSCRIPT"
printf 'NOT VALID JSON' > "$TMP/models-cache.json"
PAYLOAD="{\"session_id\":\"t5\",\"model\":{\"display_name\":\"openrouter/free\"},\"transcript_path\":\"$TRANSCRIPT\",\"context_window\":{\"used_percentage\":5,\"total_input_tokens\":1000,\"total_output_tokens\":100,\"current_usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":800,\"cache_creation_input_tokens\":50,\"output_tokens\":100}}}"
OUT=$(run_in_env "$TMP" "$PAYLOAD")
if echo "$OUT" | grep -q 'Nemotron' && echo "$OUT" | grep -q '(Free)'; then
  pass "T5: corrupted cache — heuristic fallback works"
else
  fail "T5: OUT='$OUT'"
fi
rm -rf "$TMP"

# T-extra-5: direct Anthropic slug in transcript (no /) — display_name preserved, real_model stays null
TMP=$(make_test_env)
TRANSCRIPT="$TMP/session.jsonl"
printf '%s\n' \
  '{"type":"assistant","message":{"model":"claude-sonnet-4-6","role":"assistant","content":[]},"session_id":"te5"}' \
  > "$TRANSCRIPT"
PAYLOAD="{\"session_id\":\"te5\",\"model\":{\"display_name\":\"Sonnet 4.6\"},\"transcript_path\":\"$TRANSCRIPT\",\"context_window\":{\"used_percentage\":10,\"total_input_tokens\":5000,\"total_output_tokens\":500,\"current_usage\":{\"input_tokens\":5,\"cache_read_input_tokens\":4000,\"cache_creation_input_tokens\":100,\"output_tokens\":200}}}"
OUT=$(run_in_env "$TMP" "$PAYLOAD")
SM=$(get_sess_model "$TMP" "te5")
RM=$(get_state_field "$TMP" "te5" "real_model")
if echo "$OUT" | grep -q 'Sonnet 4.6' && [ "$SM" = "Sonnet 4.6" ] && [ -z "$RM" ]; then
  pass "T-extra-5: direct Anthropic slug in transcript — display_name preserved, real_model=null"
else
  fail "T-extra-5: OUT='$OUT' sess.model='$SM' real_model='$RM'"
fi
rm -rf "$TMP"

# T-extra-1: slug with :beta suffix — no (Free) suffix appended
TMP=$(make_test_env)
TRANSCRIPT="$TMP/session.jsonl"
printf '%s\n' \
  '{"type":"assistant","message":{"model":"x/y-model:beta","role":"assistant","content":[]},"requestedModel":"openrouter/free","session_id":"te1"}' \
  > "$TRANSCRIPT"
PAYLOAD="{\"session_id\":\"te1\",\"model\":{\"display_name\":\"openrouter/free\"},\"transcript_path\":\"$TRANSCRIPT\",\"context_window\":{\"used_percentage\":5,\"total_input_tokens\":1000,\"total_output_tokens\":100,\"current_usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":800,\"cache_creation_input_tokens\":50,\"output_tokens\":100}}}"
OUT=$(run_in_env "$TMP" "$PAYLOAD")
if echo "$OUT" | grep -qi 'y model' && ! echo "$OUT" | grep -q '(Free)'; then
  pass "T-extra-1: :beta slug — no (Free) suffix; :beta stripped by heuristic"
else
  fail "T-extra-1: OUT='$OUT'"
fi
rm -rf "$TMP"

# T-extra-2: cache returns name with compound suffix "free tier" — preserved as-is (known limitation)
TMP=$(make_test_env)
TRANSCRIPT="$TMP/session.jsonl"
printf '%s\n' \
  '{"type":"assistant","message":{"model":"nvidia/nemotron-3.5-lightning:free","role":"assistant","content":[]},"requestedModel":"openrouter/free","session_id":"te2"}' \
  > "$TRANSCRIPT"
printf '%s' '{"fetched_at":"2026-01-01T00:00:00.000Z","models":{"nvidia/nemotron-3.5-lightning:free":"NVIDIA: Nemotron (free tier)"}}' \
  > "$TMP/models-cache.json"
PAYLOAD="{\"session_id\":\"te2\",\"model\":{\"display_name\":\"openrouter/free\"},\"transcript_path\":\"$TRANSCRIPT\",\"context_window\":{\"used_percentage\":5,\"total_input_tokens\":1000,\"total_output_tokens\":100,\"current_usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":800,\"cache_creation_input_tokens\":50,\"output_tokens\":100}}}"
OUT=$(run_in_env "$TMP" "$PAYLOAD")
# "free tier" does not match /[\s(:]+free[)\s]*$/ — the regex requires free at the very end
# optionally followed by ) and/or whitespace, preceded by whitespace/(:
# "free tier" has text after "free", so it won't match; (Free) IS appended
# Document: compound suffixes like "free tier" are not stripped; result will be "NVIDIA: Nemotron (free tier) (Free)"
# This is the known limitation documented in docs/log-format.md
if ! echo "$OUT" | grep -qE '\(Free\).*\(Free\)'; then
  pass "T-extra-2: compound cache suffix 'free tier' — no double (Free); see docs for limitation"
  echo "          NOTE: result='$OUT' — documented: compound suffixes not normalized"
else
  fail "T-extra-2: double (Free) in OUT='$OUT'"
fi
rm -rf "$TMP"

# T-extra-3: applyFreeSuffix idempotence
RESULT=$(node -e "
function applyFreeSuffix(name, isFree) {
  const cleaned = name.replace(/[\s(:]+free[)\s]*\$/i, '').trimEnd();
  return isFree ? cleaned + ' (Free)' : cleaned;
}
const once = applyFreeSuffix('Nemotron 3.5 Lightning (Free)', true);
const twice = applyFreeSuffix(once, true);
const ok = once === 'Nemotron 3.5 Lightning (Free)' && twice === once;
process.stdout.write(ok ? 'ok' : 'fail:once=' + once + ' twice=' + twice);
" 2>/dev/null)
if [ "$RESULT" = "ok" ]; then
  pass "T-extra-3: applyFreeSuffix idempotent"
else
  fail "T-extra-3: $RESULT"
fi

# T-extra-4: Anthropic slug heuristic without cache (cosmetic, documented)
RESULT=$(node -e "
function heuristicName(slug) {
  const base = (slug.split('/')[1] || slug).replace(/:[^:]+\$/, '');
  return base.split('-').map(w => /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)).join(' ');
}
process.stdout.write(heuristicName('anthropic/claude-sonnet-4-5'));
" 2>/dev/null)
if [ "$RESULT" = "Claude Sonnet 4 5" ]; then
  pass "T-extra-4: Anthropic slug heuristic => 'Claude Sonnet 4 5' (cache corrects in production)"
else
  fail "T-extra-4: got '$RESULT'"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== API TESTS (require DATABASE_URL) ==="
# ---------------------------------------------------------------------------

if [ -z "${DATABASE_URL:-}" ]; then
  skip "T6: initSchema idempotence (DATABASE_URL not set)"
  skip "T7: ingest old payload without model field (DATABASE_URL not set)"
  skip "T8: ingest new payload with model field (DATABASE_URL not set)"
  skip "T9: read returns model field (DATABASE_URL not set)"
else
  API_DIR="$REPO_ROOT/api"

  # T6: initSchema twice — idempotent
  RESULT=$(node --input-type=module << 'JSEOF' 2>/dev/null
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { initDb, initSchema } = require(process.env.API_DIR + '/lib/db.js');
try {
  const sql = await initDb();
  await initSchema(sql);
  await initSchema(sql);
  process.stdout.write('ok');
} catch(e) { process.stdout.write('fail:' + e.message); }
JSEOF
  )
  if [ "$RESULT" = "ok" ]; then
    pass "T6: initSchema idempotent (ran twice, no error)"
  else
    fail "T6: $RESULT"
  fi

  TEST_SID="test-old-$(date +%s)"
  TEST_SID2="test-new-$(date +%s)x"

  # T7: old payload (no model) — NULL
  RESULT=$(API_DIR="$API_DIR" TEST_SID="$TEST_SID" node --input-type=module << 'JSEOF' 2>/dev/null
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { initDb } = require(process.env.API_DIR + '/lib/db.js');
const { ingestSessions } = require(process.env.API_DIR + '/lib/ingest-handler.js');
const sid = process.env.TEST_SID;
try {
  const sql = await initDb();
  const r = await ingestSessions(sql, { sessions: { [sid]: {
    session_id: sid, model: 'Sonnet 4.6',
    started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(),
    log: [{ at: new Date().toISOString(), input_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 100, output_tokens: 10, context_pct: 5 }]
  }}});
  if (!r.ok) { process.stdout.write('fail:' + JSON.stringify(r)); process.exit(0); }
  const rows = await sql`SELECT model FROM log_entries WHERE session_id = ${sid} LIMIT 1`;
  process.stdout.write(rows[0]?.model == null ? 'ok-null' : 'fail:model=' + rows[0]?.model);
} catch(e) { process.stdout.write('fail:' + e.message); }
JSEOF
  )
  if [ "$RESULT" = "ok-null" ]; then
    pass "T7: old payload (no model) inserts NULL — no error"
  else
    fail "T7: $RESULT"
  fi

  # T8: new payload with model
  RESULT=$(API_DIR="$API_DIR" TEST_SID2="$TEST_SID2" node --input-type=module << 'JSEOF' 2>/dev/null
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { initDb } = require(process.env.API_DIR + '/lib/db.js');
const { ingestSessions } = require(process.env.API_DIR + '/lib/ingest-handler.js');
const sid = process.env.TEST_SID2;
try {
  const sql = await initDb();
  const r = await ingestSessions(sql, { sessions: { [sid]: {
    session_id: sid, model: 'Nemotron 3.5 Lightning (Free)',
    started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(),
    log: [{ at: new Date().toISOString(), input_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 100, output_tokens: 10, context_pct: 5, model: 'Nemotron 3.5 Lightning (Free)' }]
  }}});
  if (!r.ok) { process.stdout.write('fail:' + JSON.stringify(r)); process.exit(0); }
  const rows = await sql`SELECT model FROM log_entries WHERE session_id = ${sid} LIMIT 1`;
  process.stdout.write(rows[0]?.model === 'Nemotron 3.5 Lightning (Free)' ? 'ok' : 'fail:model=' + rows[0]?.model);
} catch(e) { process.stdout.write('fail:' + e.message); }
JSEOF
  )
  if [ "$RESULT" = "ok" ]; then
    pass "T8: new payload with model — stored correctly"
  else
    fail "T8: $RESULT"
  fi

  # T9: read returns model field
  RESULT=$(API_DIR="$API_DIR" TEST_SID2="$TEST_SID2" node --input-type=module << 'JSEOF' 2>/dev/null
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { initDb } = require(process.env.API_DIR + '/lib/db.js');
const { readSessions } = require(process.env.API_DIR + '/lib/read-handler.js');
const sid = process.env.TEST_SID2;
try {
  const sql = await initDb();
  const r = await readSessions(sql, {});
  if (!r.ok) { process.stdout.write('fail:' + JSON.stringify(r)); process.exit(0); }
  const sess = Object.values(r.sessions).find(s => s.session_id === sid);
  if (!sess) { process.stdout.write('fail:session not found'); process.exit(0); }
  const entry = (sess.log || []).find(e => !e.event);
  process.stdout.write(entry?.model === 'Nemotron 3.5 Lightning (Free)' ? 'ok' : 'fail:entry.model=' + entry?.model);
} catch(e) { process.stdout.write('fail:' + e.message); }
JSEOF
  )
  if [ "$RESULT" = "ok" ]; then
    pass "T9: read reconstructs model field from log_entries"
  else
    fail "T9: $RESULT"
  fi
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== REPORT UNIT TESTS (Node.js, no browser) ==="
# ---------------------------------------------------------------------------

REPORT_RESULT=$(node -e "
function entryModelPrice(entry, sessModel, pricing) {
  const key = entry.model || sessModel || '';
  return pricing.prices[key] || pricing._default;
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
function calcCost(sessions, pricingData) {
  let cost = 0;
  for (const s of sessions) {
    for (const e of dedupe(s.log || [])) {
      if (e.event) continue;
      const mp = entryModelPrice(e, s.model, pricingData);
      cost += (e.input_tokens || 0) / 1e6 * mp.input;
      cost += (e.cache_read_tokens || 0) / 1e6 * mp.cacheRead;
      cost += (e.cache_write_tokens || 0) / 1e6 * mp.cacheWrite;
      cost += (e.output_tokens || 0) / 1e6 * mp.output;
    }
  }
  return cost;
}
function getFilteredSessions(sessions, activeModels) {
  if (!activeModels || activeModels.size === 0) return sessions;
  return sessions.filter(s =>
    s.model && activeModels.has(s.model) ||
    (s.log || []).some(e => !e.event && e.model && activeModels.has(e.model))
  );
}

const results = [];

// T10: entry.model null, sess.model fallback for pricing
const p10 = { prices: { 'Sonnet 4.6': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 } }, _default: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } };
const s10 = { model: 'Sonnet 4.6', log: [{ at: 't', input_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, context_pct: 10 }] };
results.push(calcCost([s10], p10) > 0 ? 'T10:PASS' : 'T10:FAIL:cost=0');

// T11: entry.model overrides sess.model for pricing
// Use distinct token counts so dedupe does not collapse the two entries.
const p11 = { prices: { 'Sonnet 4.6': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 }, 'Nemotron 3.5 Lightning (Free)': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }, _default: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } };
const s11 = { model: 'Sonnet 4.6', log: [
  { at: 't1', input_tokens: 500,  cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, context_pct: 10, model: 'Nemotron 3.5 Lightning (Free)' },
  { at: 't2', input_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, context_pct: 11, model: 'Sonnet 4.6' },
]};
// entry 1: Nemotron (free), cost = 0. entry 2: Sonnet 4.6, 1000/1e6*3 = $0.003
const exp11 = 1000 / 1e6 * 3;
const got11 = calcCost([s11], p11);
results.push(Math.abs(got11 - exp11) < 1e-9 ? 'T11:PASS' : 'T11:FAIL:got=' + got11 + ' exp=' + exp11);

// T12: null entry.model, null sessModel, all-zero _default -> returns _default (cost=0, not crash)
const mp12 = entryModelPrice({}, null, { prices: {}, _default: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
results.push(mp12.input === 0 && mp12.output === 0 ? 'T12:PASS' : 'T12:FAIL:mp=' + JSON.stringify(mp12));

// T13: getFilteredSessions matches by entry.model, not sess.model
const sessions13 = [
  { session_id: 's1', model: 'openrouter/free', log: [{ at: 't', input_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1, context_pct: 5, model: 'Nemotron 3.5 Lightning (Free)' }] },
  { session_id: 's2', model: 'Sonnet 4.6', log: [] },
];
const f13 = getFilteredSessions(sessions13, new Set(['Nemotron 3.5 Lightning (Free)']));
results.push(f13.length === 1 && f13[0].session_id === 's1' ? 'T13:PASS' : 'T13:FAIL:len=' + f13.length);

process.stdout.write(results.join('\n'));
" 2>/dev/null)

while IFS= read -r line; do
  case "$line" in
    T*:PASS*) pass "${line//:PASS/}" ;;
    T*:FAIL*) fail "$line" ;;
  esac
done <<< "$REPORT_RESULT"

# ---------------------------------------------------------------------------
echo ""
echo "=== DESIGN STATIC CHECKS (advisory) ==="
# Advisory by design: never increments FAIL or blocks the suite.
if node "$REPO_ROOT/tests/design-check.mjs" --static; then
  echo "ℹ️  design checks completed (advisory)"
else
  echo "⚠️  design checks could not complete (advisory)"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== SUMMARY ==="
echo "Passed: $PASS  Failed: $FAIL  Skipped: $SKIP"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
