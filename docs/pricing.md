# Report Pricing

The report estimates costs for every exchange in the log. Prices live in the browser's
`localStorage` (key `claude_usage_stats_pricing`) and are auto-populated from the
[Portkey Models API](https://www.portkey.ai/) pricing data, with manual overrides.

## Storage schema (version 2)

```jsonc
{
  "version": 2,
  "prices": {
    "Sonnet 4.6": {
      "input": 3,           // USD per million input tokens
      "cacheRead": 0.3,     // USD per million cache-read tokens
      "cacheWrite": 3.75,   // USD per million cache-write tokens
      "output": 15,         // USD per million output tokens
      "source": "portkey",  // "manual" | "portkey" | "legacy"
      "portkeyId": "anthropic/claude-sonnet-4-6",
      "syncAt": "2026-11-08T21:59:21.731Z",   // last successful sync
      "lastAttemptAt": null,                  // last sync attempt (success or failure)
      "autoFailed": false,                    // true = not found on Portkey
      "history": [                            // price valid until the next entry
        { "at": "…", "input": 3, "cacheRead": 0.3, "cacheWrite": 3.75, "output": 15, "source": "portkey" }
      ]
    }
  },
  "_default": { "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0 }
}
```

Migrated pre-v2 entries get `source: "legacy"`. Manual saves set `source: "manual"` and are
never overwritten by the sync.

## Auto-population (Portkey)

- **Trigger**: after every data load, and then every ~6 hours (with 0–15 min jitter), from
  `portkey.js`. A button in the pricing modal ("Resync prices") runs it on demand.
- **Source**: `https://configs.portkey.ai/pricing/{provider}.json` — one bulk JSON per
  provider, no API key. Cached in localStorage for 24h (key `claude_usage_stats_portkey_cache`).
- **Unit conversion**: the API returns **cents per token**; `$ per million tokens = cents × 1e4`
  (e.g. `0.0003` → `$3/MTok`). Conversion is centralized in `centsToMtok()`.
- **Resolution order** per model display name:
  1. `_state.real_model` slug from the session → `{provider}/{model}` directly
  2. Provider hint from the commercial name (keyword → provider, e.g. "Sonnet" → anthropic)
  3. The `openrouter` aggregate JSON (covers providers with no bulk file, e.g. `xingchen-agi`)

  Matching within a provider file is fuzzy: exact key → normalized exact → substring
  containment (≥6 chars) or token containment (every ≥3-char word of the name appears in
  the key). Names containing "free" only match `:free` variants.
- **Free models are $0 by rule**: a model whose display name is `(Free)`, whose slug
  ends in `:free`, or that is the `openrouter/free` router is always priced $0, whatever
  the matched config says. The display name is authoritative because router sessions
  pair entry names with stale `_state.real_model` slugs, and Portkey configs can carry
  paid prices under `:free` keys (e.g. `deepseek-v4-flash` rates stored under a
  mispaired free name).
- **Not found**: the model is flagged `autoFailed` and keeps its last values (if any) —
  except free models, which are zeroed instead of staying frozen at an old wrong price.
  Models never priced and absent from the API simply stay unpriced (`⚠` in the modal) —
  no phantom entries are created.

## Cost calculation

- Per log entry: `tokens / 1e6 × price.component`, summed over
  input/cache-read/cache-write/output. Prices without an entry fall back to `_default`.
- **Retroactive**: `findPrice(key, pricing, timestamp)` resolves the price in effect at a
  date. Each `history` point records the value that was **replaced** at its `at` moment, so
  the price in effect at `t` is the value of the first history point with `at > t` — or the
  current price when there is none. This makes cost charts (and per-entry costs in the log
  table) reflect the price in effect on each day, e.g. after a mid-month price change, for
  exact and fuzzy matches alike. Manual prices (no history) apply to all dates.
- Consumed by the cost stat (`render.js`), the log table (`log-table.js`) and the daily
  cost chart (`daily-chart.js`).

## Modal UI

- Prices tab: model dropdown grouped by family, four price fields, free-model toggle,
  resync button. Opens with no model preloaded.
- Configured tab: header row + one grid per model (name, 4 prices, sync date, remove).
  Inline source icons: `✓` Portkey, `✎` manual/legacy, `⚠` auto-population failed.
- Manual entry: select "Other / Add manually" in the dropdown, or edit an existing model —
  saving marks it `manual` (protected from the sync).