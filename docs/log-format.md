# Log Format

The log is stored as `~/.claude/claude-usage-stats/claude-usage-stats-log.json` (or inside your backup repo if configured).

## Top-level structure

```json
{
  "sessions": {
    "<session_id>": { ... }
  }
}
```

## Session object

```json
{
  "session_id": "a1b2c3d4-...",
  "session_name": "Feature implementation",
  "profile": "client-a",
  "model": "Nemotron 3.5 Lightning (Free)",
  "started_at": "2026-10-05T10:00:00.000Z",
  "last_activity_at": "2026-10-05T11:52:00.000Z",
  "_state": {
    "total_in": 151200,
    "total_out": 9100,
    "last_ctx": 41,
    "real_model": "nvidia/nemotron-3.5-lightning:free"
  },
  "log": [ ... ]
}
```

| Field | Description |
|---|---|
| `session_id` | UUID from Claude Code's hook payload; stable across `--resume` |
| `session_name` | User-provided session name, if any |
| `profile` | Value of `$CLAUDE_USAGE_PROFILE` at the time of the exchange; `null` if unset |
| `model` | Commercial display name of the model at last activity (e.g. `"Nemotron 3.5 Lightning (Free)"`) |
| `started_at` | ISO timestamp of the first recorded exchange |
| `last_activity_at` | ISO timestamp of the most recent exchange |
| `_state` | Internal tracking state (do not rely on these values) |
| `_state.total_in` | Last seen cumulative input token count (for compact detection) |
| `_state.total_out` | Last seen cumulative output token count (for compact detection) |
| `_state.last_ctx` | Last non-zero context percentage (used for stale display) |
| `_state.real_model` | Internal: last seen model slug from the transcript (e.g. `"nvidia/nemotron-3.5-lightning:free"`). Used by the script to resolve the commercial name on subsequent calls. Do not rely on this field. |

## Log entry: exchange

```json
{
  "at": "2026-10-05T10:18:00.000Z",
  "input_tokens": 1,
  "cache_read_tokens": 101200,
  "cache_write_tokens": 3100,
  "output_tokens": 1250,
  "context_pct": 53,
  "model": "Nemotron 3.5 Lightning (Free)"
}
```

| Field | Description |
|---|---|
| `at` | ISO timestamp |
| `input_tokens` | Raw (non-cached) input tokens for this exchange |
| `cache_read_tokens` | Tokens served from prompt cache (cheap) |
| `cache_write_tokens` | Tokens written to prompt cache (more expensive) |
| `output_tokens` | Output tokens generated |
| `context_pct` | Context window fill % at the time of this exchange |
| `model` | Commercial display name of the model that generated this response (the requested model, or the routed model when a freshly scanned router slug differs). Absent on old log entries and exchanges where `transcript_path` was not available. When absent, the report falls back to the session-level `model` field for pricing and display. |

**Note:** `cache_write_tokens` spikes after a cold start or `--resume` because the full prompt must be re-cached. Subsequent exchanges in the same session have high `cache_read_tokens` and low `cache_write_tokens`.

**Note on `model` accuracy:** entries carry the payload's `display_name` — the model Claude Code *requested*. When the freshly scanned transcript slug denotes a different model than requested (router aliases like `openrouter/free`/`openrouter/auto`, where OpenRouter routes each request to a real model), the **routed** model's resolved name is recorded instead, so per-entry attribution reflects what actually answered. The routed slug is read from the transcript incrementally per hook call; if two exchanges complete between hook calls (background agents, parallel streams), only the last assistant entry's slug is scanned — rare, and the entry then falls back to the requested name.

**Note on heuristic names:** when `models-cache.json` does not exist or does not contain an entry for the slug (e.g. on first install), the script generates a name heuristically by stripping the provider prefix and `:free`/`:beta`/`:nitro` suffixes and capitalizing words. Example: `anthropic/claude-sonnet-4-5` → `Claude Sonnet 4 5`. The cache (fetched automatically in background from `openrouter.ai/api/v1/models`, TTL 24h) corrects these names on subsequent calls.

## Log entry: compact event

```json
{
  "at": "2026-10-05T11:14:00.000Z",
  "event": "compact",
  "context_pct": 0
}
```

A compact event is recorded when the cumulative token totals decrease (indicating Claude Code condensed the context). `context_pct` is typically 0 at this moment.

## Cache hit rate

```
cache_hit_rate = cache_read_tokens / (input_tokens + cache_read_tokens + cache_write_tokens)
```

A high cache hit rate (>90%) means most input was served from cache, significantly reducing cost.
