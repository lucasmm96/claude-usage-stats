# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A Claude Code status line hook that persists token usage and context window data across sessions. Users install `scripts/claude-usage-stats.sh` into `~/.claude/claude-usage-stats/` and register it in `~/.claude/settings.json`. The report is a zero-dependency SPA that renders the log with cost estimates. There is no build step and no test suite; the optional `api/` directory holds Vercel serverless functions (not required for local use).

## Files

- **`scripts/claude-usage-stats.sh`** — the status line hook. A bash script with an embedded `node -` one-liner (no npm deps). Claude Code calls it after every response, piping a JSON payload to stdin.
- **`report/index.html`** — the SPA entry; loads `report/js/*` in order (see script tags — order matters).
- **`report/js/config.js`** — localStorage keys and globals (`globalData`, `activeModels`, …).
- **`report/js/pricing.js`** — pricing storage (schema v2), modal logic, cost calculation, source icons.
- **`report/js/portkey.js`** — Portkey price auto-population engine (fetch, resolution, sync timer).
- **`report/js/utils.js`** — shared helpers, `findPrice`/`entryModelPrice` (retro pricing via history), session filtering.
- **`report/js/render.js`**, **`log-table.js`**, **`daily-chart.js`**, **`charts.js`** — rendering + cost aggregations.
- **`report/js/loaders.js`**, **`github.js`**, **`api.js`**, **`auto-refresh.js`** — data loading paths and polling.
- **`report/css/`** — per-component stylesheets (`base`, `layout`, `modal`, `detail`, `log-table`, `tokens`, `motion`).
- **`api/`** — optional Vercel serverless deployment (auth, ingest, sessions) with its own `package.json`.
- **`examples/sessions.example.json`** — anonymized sample data. Update this when the log schema changes.
- **`docs/`** — user-facing documentation. `log-format.md` is the authoritative log schema; `pricing.md` documents the report pricing system.

## Architecture

### Hook pipeline (`claude-usage-stats.sh`)

1. Bash reads the full stdin payload into `$input`
2. Passes it to an inline `node -` script via heredoc (`JSEOF`)
3. Node.js parses the JSON, reads `~/.claude/claude-usage-stats/claude-usage-stats-log.json`, finds/creates the session by `session_id`, then:
   - Detects compact events: `(total_in + total_out)` decreasing vs previous
   - Deduplicates streaming artifacts: identical token values on consecutive calls
   - Scans new bytes of the JSONL transcript (from `title_scan_offset`) for `custom-title` events
   - Resolves the model slug (`_state.real_model`) to a commercial display name via `models-cache.json` or `heuristicName`
   - Writes the updated JSON back to disk
   - Outputs a tab-separated string: `model\tctx_int\tctx_color\tctx_suffix\ttok_k`
4. Bash reads those five fields and formats the final colored status line string
5. If `BACKUP_REPO` is configured, a background subshell runs `git add/commit/push`

### Session state (`_state` object)

`_state` is the script's internal memory across calls. Key fields:
- `total_in` / `total_out` — last cumulative totals, used for compact detection
- `last_ctx` — last non-zero context %, shown with `~` suffix when current reading is 0
- `real_model` — last seen model slug (e.g. `"nvidia/nemotron-3.5-lightning:free"`); the report uses it to resolve Portkey prices
- `custom_title` / `title_scan_offset` — incremental JSONL scan position for session renames

### Pricing pipeline (report)

- **Storage**: localStorage key `claude_usage_stats_pricing`, schema **version 2**. Each price entry: `{ input, cacheRead, cacheWrite, output }` (USD per million tokens) plus `source` (`manual|portkey|legacy`), `syncAt`, `lastAttemptAt`, `autoFailed`, `history[]` (past values with timestamps). See `docs/pricing.md`.
- **Auto-population** (`portkey.js`): after every data load and every ~6h (jittered), collects every model in the log and fetches bulk pricing JSONs from `configs.portkey.ai/pricing/{provider}.json` (24h localStorage cache). Resolution order per model: `_state.real_model` slug → provider-name hint on the commercial name → `openrouter` aggregate JSON. Matching is fuzzy (normalized exact, then substring/token containment). `manual` entries are never overwritten; models absent from the API are flagged `autoFailed` (shown as `⚠`).
- **Costs**: `findPrice(key, pricing, timestamp?)` resolves a price, falling back to normalized/containment matches, then `pricing._default`. With a timestamp, it returns the price in effect at that date from `history` (retroactive). Manual prices have no history, so they apply to all dates.
- **UI**: the pricing modal (`#pricing-modal-overlay`) has Prices and Configured tabs; a resync button re-runs the Portkey sync; Configured shows inline source icons (`✓` Portkey, `✎` manual/legacy, `⚠` auto-fail) with sync dates; the modal is 800px wide, opens without a preloaded model.

### Report page (`report/index.html`)

Four data-loading paths, all converge to `loadJson()` → `renderAll()`:
- **Local file**: FileReader API
- **Public URL**: `fetch()` with CORS
- **Private GitHub repo**: `fetch()` to `api.github.com` with `Authorization: token <PAT>`, credentials stored in `localStorage`
- **Database API**: `fetch()` to the Vercel deployment with a bearer key

`loadJson` also kicks off the Portkey price sync. `auto-refresh.js` polls URL/GitHub/API sources with ETag, backoff and pause-on-hidden-tab.

## Testing changes

### Script (hook)

```bash
echo '{"session_id":"test-123","model":{"display_name":"Sonnet 4.6"},"context_window":{"used_percentage":42,"total_input_tokens":100000,"total_output_tokens":5000,"current_usage":{"input_tokens":10,"cache_read_input_tokens":80000,"cache_creation_input_tokens":1000,"output_tokens":500}}}' | bash scripts/claude-usage-stats.sh
```

To test with an empty/malformed payload (should degrade gracefully):

```bash
echo '{}' | bash scripts/claude-usage-stats.sh
```

The Node.js portion can be extracted and run with `node -e` for isolated debugging.

### Report / pricing

Open `report/index.html` (e.g. `python -m http.server` in the repo root, or `file://`), load a sessions file (URL param `?data=` or file picker), then check `$ Pricing` → Configured. Portkey sync needs network access; provider JSONs have CORS enabled. Manual smoke check: `node --check report/js/portkey.js report/js/pricing.js report/js/utils.js`. There is no automated test suite.

## Key invariants

- **No npm dependencies** — the Node.js one-liner uses only built-in `fs` and `process`. Keep it that way.
- **Idempotent writes** — duplicate hook calls (streaming artifacts) must not produce duplicate log entries. The dedup check compares all four token fields.
- **`session_id` is the stable key** — not `$PPID`. The `session_id` from the hook payload survives `--resume`.
- **Stale context display** — when `used_percentage` is 0 and `last_ctx > 0`, show `last_ctx` with `~` suffix, not `0%`.
- **Compact detection** — compare cumulative totals to previous, not per-exchange totals. A compact resets cumulative totals to lower values.
- **Manual prices are sacred** — the Portkey sync must never overwrite a `source: 'manual'` entry, only refresh its metadata.
- **Pricing schema versioned** — `getPricingData()` migrates old blobs to version 2 in place, one-time.
- **One global `MAX_HISTORY`** — declared once in `portkey.js`; classic `<script>` tags share the global lexical environment, so redeclaring it in `pricing.js` throws a SyntaxError and kills both scripts. Never redeclare top-level `const`/`let` that another report script declares.
- **`normKey` lives in `pricing.js`** (Helpers section) but is used by `utils.js:findPrice` and `portkey.js:lookupModelPricing`. Keep it global.