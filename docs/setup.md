# Setup Guide

## How the hook works

Claude Code calls the `statusLine.command` after every response (and every `refreshInterval` seconds, if configured), passing a JSON payload to stdin. The payload includes:

- `session_id` — UUID tied to the transcript file; stable across `--resume`
- `session_name` — the name you gave the session
- `model.display_name` — e.g. `"Sonnet 4.6"`
- `context_window.used_percentage` — current context fill (0 after `/compact` until next update)
- `context_window.total_input_tokens` / `total_output_tokens` — cumulative window totals
- `context_window.current_usage` — per-exchange breakdown: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`

The script processes this payload with an inline Node.js script (`node -`), which:

1. Acquires a lock, then reads `~/.claude/claude-usage-stats/claude-usage-stats-log.json`
2. Finds or creates the session entry
3. Takes the title from the live `session_name` payload, falling back to the transcript scan
4. Detects compact events (cumulative totals decrease)
5. Deduplicates streaming artifacts (same token values fired multiple times per exchange)
6. Appends the exchange entry and writes the file atomically; skips the write when nothing changed
7. Outputs a tab-separated result string that the bash script formats for display

## Installation

**Prerequisites:** Bash, Node.js, Claude Code CLI.

On Windows, use Git Bash or WSL to run bash scripts.

**Step 1 — Copy the script:**

```bash
mkdir -p ~/.claude/claude-usage-stats
cp scripts/claude-usage-stats.sh ~/.claude/claude-usage-stats/
```

**Step 2 — Add to `~/.claude/settings.json`:**

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/claude-usage-stats/claude-usage-stats.sh",
    "refreshInterval": 10
  }
}
```

`refreshInterval` re-runs the hook every N seconds in addition to event-driven updates. Without it, a session rename is only picked up after the next response; with it, renames reach the log within N seconds.

**Step 3 — Verify:**

Open a Claude Code session. After the first response, you should see:

```
Model: Sonnet 4.6 | Context: 42% | Tokens: 109.0k
```

## Troubleshooting

**Nothing appears:**
- Check that Node.js is on your `$PATH`: `node --version`
- Check that the script is executable: `chmod +x ~/.claude/claude-usage-stats/claude-usage-stats.sh`
- Run the script manually with sample input to see errors:
  ```bash
  echo '{}' | bash ~/.claude/claude-usage-stats/claude-usage-stats.sh
  ```

**Context shows `0%` or `0~%` permanently:**
- `0%` on the first exchange after startup is normal (Claude Code sends 0 before the first real value)
- `42~%` after `/compact` is expected — the `~` disappears after the next exchange
- If it persists, the `_state.last_ctx` field in the JSON may need to be reset

**Token count resets on `--resume`:**
- This was the old behavior when using `$PPID` as session ID. The current script uses `session_id` from the hook payload, which is stable across `--resume`. If you have an old version, re-copy the script.

**Log file grows large:**
- Each exchange adds one entry (~200 bytes). 10,000 exchanges ≈ 2 MB. This is negligible.
- You can prune old sessions manually or archive them.

## What `69~` means

When you run `/compact`, Claude Code resets the context window and sends `used_percentage: 0` in the first hook call(s) after compact. The script falls back to the last known value with a `~` suffix to show it's stale. It disappears after the next exchange once Claude Code reports the real post-compact percentage.
