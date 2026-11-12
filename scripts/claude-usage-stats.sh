#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input=$(cat)
PPID_FALLBACK="$PPID"

# --- Optional backup config ---
# Create backup.conf in the same directory as this script to enable background git push.
BACKUP_REPO=""               # absolute path to local git clone
BACKUP_BRANCH="main"
BACKUP_FILE="sessions.json"
BACKUP_PUSH_INTERVAL=60      # min seconds between pushes (default: 1 min)

CONF="$SCRIPT_DIR/backup.conf"
# shellcheck source=/dev/null
[ -f "$CONF" ] && source "$CONF"

LOG_FILE="$SCRIPT_DIR/claude-usage-stats-log.json"
CACHE_FILE="$SCRIPT_DIR/models-cache.json"

# --- Serialize the log read-modify-write across concurrent hook calls ---
# mkdir is atomic. Wait up to 3s for the lock, then proceed unlocked so the status line never hangs.
LOG_LOCK="$LOG_FILE.lock.d"
_lock_acquired=""
_i=0
while [ "$_i" -lt 60 ]; do
  if mkdir "$LOG_LOCK" 2>/dev/null; then _lock_acquired=1; break; fi
  _lock_age=$(( $(date +%s) - $(date -r "$LOG_LOCK" +%s 2>/dev/null || echo 0) ))
  [ "$_lock_age" -gt 10 ] && { rmdir "$LOG_LOCK" 2>/dev/null; continue; }
  sleep 0.05
  _i=$((_i + 1))
done
trap '[ -n "$_lock_acquired" ] && rmdir "$LOG_LOCK" 2>/dev/null' EXIT

result=$(node - "$input" "$LOG_FILE" "$PPID_FALLBACK" "${CLAUDE_USAGE_PROFILE:-}" "$CACHE_FILE" 2>/dev/null << 'JSEOF'
const fs = require('fs');
const [,, rawInput, logFile, ppidFallback, profileArg, cacheFilePath] = process.argv;

let d = {};
try { d = JSON.parse(rawInput); } catch(e) {}

const sessionId      = d.session_id                             ?? ppidFallback;
const sessionName    = d.session_name                           ?? null;
const transcriptPath = d.transcript_path                        ?? null;
const profile        = (profileArg && profileArg.trim())        ? profileArg.trim() : null;
const model          = d.model?.display_name                    ?? 'Unknown';
const used_pct       = d.context_window?.used_percentage        ?? 0;
const total_in       = d.context_window?.total_input_tokens     ?? 0;
const total_out      = d.context_window?.total_output_tokens    ?? 0;
const usage          = d.context_window?.current_usage          ?? {};
const nowIso         = new Date().toISOString();

const input_tokens       = usage.input_tokens                ?? 0;
const cache_read_tokens  = usage.cache_read_input_tokens     ?? 0;
const cache_write_tokens = usage.cache_creation_input_tokens ?? 0;
const output_tokens      = usage.output_tokens               ?? 0;
const exchange_total     = input_tokens + cache_read_tokens + cache_write_tokens + output_tokens;

let rawLog = '';
let data = { sessions: {} };
try { rawLog = fs.readFileSync(logFile, 'utf8'); data = JSON.parse(rawLog); } catch(e) {}
if (!data.sessions) data.sessions = {};

let sess = data.sessions[sessionId] ?? {
  session_id: sessionId,
  session_name: sessionName,
  profile,
  model,
  started_at: nowIso,
  last_activity_at: nowIso,
  _state: { total_in: 0, total_out: 0, last_ctx: 0, custom_title: null, title_scan_offset: 0 },
  log: []
};

const st       = sess._state ?? {};
const prev_in  = st.total_in  ?? 0;
const prev_out = st.total_out ?? 0;
const last_ctx = st.last_ctx  ?? 0;

// --- Read custom-title and real model from JSONL transcript (incremental, only new bytes) ---
let custom_title       = st.custom_title       ?? null;
let title_scan_offset  = st.title_scan_offset  ?? 0;
let real_model         = st.real_model         ?? null; // slug, e.g. "nvidia/nemotron-3.5-lightning:free"
if (real_model && !real_model.includes('/')) real_model = null; // clear stale direct-Anthropic slug

if (transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    const fileSize = stat.size;
    // Transcript shrunk → new file created for this resume; reset scan state and stale model slug.
    if (fileSize < title_scan_offset) {
      title_scan_offset = 0;
      real_model = null;
    }
    if (fileSize > title_scan_offset) {
      const readFrom = Math.max(0, title_scan_offset - 100); // slight overlap to avoid partial-line issues
      const buf = Buffer.alloc(fileSize - readFrom);
      const fd = fs.openSync(transcriptPath, 'r');
      fs.readSync(fd, buf, 0, buf.length, readFrom);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const lastIdx = lines.length - 1;

      // Parses one JSONL line; returns false when the line is incomplete or invalid.
      const scanLine = (line) => {
        const t = line.trim();
        if (!t) return true;
        try {
          const entry = JSON.parse(t);
          if (entry.type === 'custom-title' && entry.customTitle) {
            custom_title = entry.customTitle;
          }
          if (entry.type === 'assistant' && entry.message?.model && entry.message.model.includes('/')) {
            real_model = entry.message.model;
          }
          return true;
        } catch(e) {
          return false;
        }
      };

      for (let i = 0; i < lastIdx; i++) scanLine(lines[i]);

      // Final line has no trailing newline: parse it when complete, otherwise re-read it next run.
      const lastLine     = lines[lastIdx] ?? '';
      const lastLineDone = lastLine.trim() !== '' && scanLine(lastLine);

      const lastNl = text.lastIndexOf('\n');
      title_scan_offset = readFrom + (
        lastLineDone ? text.length
        : lastNl >= 0 ? lastNl + 1
        : 0
      );
    }
  } catch(e) {}
}

// --- Resolve commercial name from slug ---

// Converts a slug to a readable name without network.
// "nvidia/nemotron-3.5-lightning:free" -> "Nemotron 3.5 Lightning"
function heuristicName(slug) {
  const base = (slug.split('/')[1] || slug).replace(/:[^:]+$/, '');
  return base.split('-').map(w => /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Ensures canonical "(Free)" suffix when slug ends with ":free".
// Strips any existing free-related suffix before (re)appending.
// isFree is derived from the original slug, not from the name.
function applyFreeSuffix(name, isFree) {
  const cleaned = name.replace(/[\s(:]+free[)\s]*$/i, '').trimEnd();
  return isFree ? cleaned + ' (Free)' : cleaned;
}

let modelCacheMap = {};
try {
  const raw = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
  modelCacheMap = raw.models || {};
} catch(e) {}

const isFree = real_model ? real_model.endsWith(':free') : false;
const baseName = real_model
  ? (modelCacheMap[real_model] || heuristicName(real_model))
  : model; // fallback: display_name from payload (e.g. "Sonnet 4.6"), left untouched
const displayModel = real_model ? applyFreeSuffix(baseName, isFree) : baseName;

// Payload session_name is live (reflects a rename immediately); scanned title is the fallback.
const effectiveName = sessionName ?? custom_title;

const is_compact = (total_in + total_out) < (prev_in + prev_out) && (prev_in + prev_out) > 0;
let hadActivity = false;

if (is_compact) {
  sess.log.push({ at: nowIso, event: 'compact', context_pct: used_pct });
  hadActivity = true;
} else if (exchange_total > 0) {
  const last = [...sess.log].reverse().find(e => !e.event);
  const is_dup = last &&
    last.input_tokens       === input_tokens &&
    last.cache_read_tokens  === cache_read_tokens &&
    last.cache_write_tokens === cache_write_tokens &&
    last.output_tokens      === output_tokens;
  if (!is_dup) {
    sess.log.push({
      at: nowIso, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, context_pct: used_pct,
      ...((d.model && d.model.display_name) ? { model: d.model.display_name } : {}),
    });
    hadActivity = true;
  }
}

const nameChanged    = !!effectiveName && effectiveName !== sess.session_name;
const modelChanged   = sess.model !== displayModel;
const profileChanged = profile !== null && sess.profile !== profile;

sess._state = { total_in, total_out, last_ctx: used_pct > 0 ? used_pct : last_ctx, custom_title, title_scan_offset, real_model };
if (profile !== null) sess.profile = profile;
sess.model = displayModel;
// Periodic status line refreshes are not activity: only touch last_activity_at on real changes.
if (hadActivity || nameChanged || modelChanged || profileChanged || !sess.last_activity_at) sess.last_activity_at = nowIso;
if (effectiveName) sess.session_name = effectiveName;
// Canonical field order (docs/log-format.md): rebuild the session object so
// profile/model sit between session_name and started_at even for sessions
// created by older script versions that appended those keys after `log`.
data.sessions[sessionId] = {
  session_id: sess.session_id,
  session_name: sess.session_name,
  profile: sess.profile,
  model: sess.model,
  started_at: sess.started_at,
  last_activity_at: sess.last_activity_at,
  _state: sess._state,
  log: sess.log,
};

const outLog = JSON.stringify(data, null, 2);
if (outLog !== rawLog) {
  const tmpLog = logFile + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpLog, outLog);
    fs.renameSync(tmpLog, logFile); // atomic replace: concurrent readers never see a partial file
  } catch(e) {
    try { fs.writeFileSync(logFile, outLog); } catch(e2) {}
    try { fs.unlinkSync(tmpLog); } catch(e2) {}
  }
}

const session_total = sess.log
  .filter(e => !e.event)
  .reduce((s, e) => s + (e.input_tokens ?? 0) + (e.cache_read_tokens ?? 0) + (e.cache_write_tokens ?? 0) + (e.output_tokens ?? 0), 0);

const display_ctx   = used_pct === 0 && last_ctx > 0 ? last_ctx : used_pct;
const ctx_was_stale = used_pct === 0 && last_ctx > 0;
const tok_k         = session_total >= 1e9 ? (session_total / 1e9).toFixed(1) + 'B'
                    : session_total >= 1e6 ? (session_total / 1e6).toFixed(1) + 'M'
                    : session_total >= 1e3 ? (session_total / 1e3).toFixed(1) + 'k'
                    : String(session_total);
const ctx_int       = Math.round(display_ctx);
const ctx_color     = display_ctx >= 80 ? '31' : display_ctx >= 60 ? '33' : '32';
const ctx_suffix    = ctx_was_stale ? '~' : '%';

process.stdout.write([displayModel, ctx_int, ctx_color, ctx_suffix, tok_k].join('\t'));
JSEOF
)
[ -n "$_lock_acquired" ] && rmdir "$LOG_LOCK" 2>/dev/null

IFS=$'\t' read -r model ctx_int ctx_color ctx_suffix tok_k <<< "$result"
[ -z "$model" ] && { model="Unknown"; ctx_int=0; ctx_color=32; ctx_suffix="%"; tok_k="0"; }

# --- Background backup (if configured) ---
if [ -n "$BACKUP_REPO" ] && [ -d "$BACKUP_REPO/.git" ]; then
  (
    _BKLOCK="$BACKUP_REPO/.claude-usage-stats.lock.d"
    if [ -d "$_BKLOCK" ]; then
      _AGE=$(( $(date +%s) - $(date -r "$_BKLOCK" +%s 2>/dev/null || echo 0) ))
      [ "$_AGE" -lt 120 ] && exit 0
      rmdir "$_BKLOCK" 2>/dev/null
    fi
    mkdir "$_BKLOCK" 2>/dev/null || exit 0
    cp "$LOG_FILE" "$BACKUP_REPO/$BACKUP_FILE"
    cd "$BACKUP_REPO" || { rmdir "$_BKLOCK" 2>/dev/null; exit 1; }
    git add "$BACKUP_FILE"
    if ! git diff --cached --quiet; then
      git commit -m "auto: $(date -u +%Y-%m-%dT%H:%M:%SZ)" --quiet
      NOW=$(date +%s)
      LAST=$(cat .last_push 2>/dev/null || echo 0)
      if [ $(( NOW - LAST )) -gt "$BACKUP_PUSH_INTERVAL" ]; then
        git push origin "$BACKUP_BRANCH" --quiet 2>/dev/null && echo "$NOW" > .last_push
      fi
    fi
    rmdir "$_BKLOCK" 2>/dev/null
  ) &>/dev/null &
fi

# --- Background API upload (if configured) ---
if [ -n "$API_URL" ] && [ -n "$API_KEY" ]; then
  (
    _APILOCK="$SCRIPT_DIR/.claude-usage-stats-api.lock.d"
    if [ -d "$_APILOCK" ]; then
      _AGE=$(( $(date +%s) - $(date -r "$_APILOCK" +%s 2>/dev/null || echo 0) ))
      [ "$_AGE" -lt 120 ] && exit 0
      rmdir "$_APILOCK" 2>/dev/null
    fi
    mkdir "$_APILOCK" 2>/dev/null || exit 0
    _CURSOR_FILE="$SCRIPT_DIR/.claude-usage-stats-api-cursor"
    _DELTA_FILE="$SCRIPT_DIR/.claude-usage-stats-api-delta.json"
    node -e "
const fs = require('fs');
const [logFile, cursorFile, deltaFile] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(logFile, 'utf8'));
let cursor = '';
try { cursor = fs.readFileSync(cursorFile, 'utf8').trim(); } catch(e) {}
const sevenDaysAgo = new Date(Date.now() - 7*24*3600*1000).toISOString();
const cutoff = (!cursor || cursor < sevenDaysAgo) ? sevenDaysAgo : cursor;
const out = {};
for (const [id, sess] of Object.entries(data.sessions || {})) {
  if (!sess.last_activity_at || sess.last_activity_at >= cutoff) out[id] = sess;
}
fs.writeFileSync(deltaFile, JSON.stringify({ sessions: out }));
" "$LOG_FILE" "$_CURSOR_FILE" "$_DELTA_FILE"
    curl -s --fail-with-body \
      -X POST "$API_URL/api/ingest" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      --data-binary @"$_DELTA_FILE" \
      >/dev/null 2>&1 && date -u +%Y-%m-%dT%H:%M:%SZ > "$_CURSOR_FILE"
    rm -f "$_DELTA_FILE"
    rmdir "$_APILOCK" 2>/dev/null
  ) &
fi

# --- Background model cache refresh (if curl available, TTL 24h) ---
if command -v curl >/dev/null 2>&1; then
  (
    _MCACHE="$CACHE_FILE"
    _MLOCK="$SCRIPT_DIR/.claude-usage-stats-models.lock.d"
    if [ -f "$_MCACHE" ]; then
      _AGE=$(( $(date +%s) - $(date -r "$_MCACHE" +%s 2>/dev/null || echo 0) ))
      [ "$_AGE" -lt 86400 ] && exit 0
    fi
    mkdir "$_MLOCK" 2>/dev/null || exit 0
    _TMP="$SCRIPT_DIR/.claude-usage-stats-models-tmp.$$.json"
    curl -sf --max-time 10 --connect-timeout 5 \
      "https://openrouter.ai/api/v1/models" -o "$_TMP" 2>/dev/null
    if [ -f "$_TMP" ]; then
      node -e "
const fs = require('fs');
const [,,src,dst] = process.argv;
try {
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
  const models = {};
  for (const m of raw.data || []) { if (m.id && m.name) models[m.id] = m.name; }
  fs.writeFileSync(dst + '.tmp', JSON.stringify({ fetched_at: new Date().toISOString(), models }));
  fs.renameSync(dst + '.tmp', dst);
} catch(e) {}
" - "$_TMP" "$_MCACHE" 2>/dev/null
      rm -f "$_TMP"
    fi
    rmdir "$_MLOCK" 2>/dev/null
  ) &>/dev/null &
fi

CYAN='\033[36m'
RESET='\033[0m'
MAGENTA='\033[35m'

printf "Model: ${CYAN}%s${RESET} | Context: \033[%sm%s%s\033[0m | Tokens: ${MAGENTA}%s${RESET}\n" \
    "$model" "$ctx_color" "$ctx_int" "$ctx_suffix" "$tok_k"
