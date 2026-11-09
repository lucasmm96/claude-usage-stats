# Claude Usage Stats

A Claude Code status line hook that persists token usage and context window data across sessions — including `/compact` resets and `--resume` reopens.

```
Model: Sonnet 4.6 | Context: 42% | Tokens: 1.2M
```

- Context % survives `/compact` (shows stale value with `~` until the next real reading)
- Token counter accumulates across the entire session, including after compacts
- Session identity tied to Claude Code's `session_id` UUID — survives `--resume`
- Session renames (UI or `--title`) are picked up automatically from the transcript
- Logs per-exchange token breakdown to a JSON file for later analysis
- Optional: auto-push the log to a private git repo in the background
- Optional: auto-upload the log to a Neon PostgreSQL database via a Vercel API

---

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI installed and working
- Bash (on Windows: Git Bash or WSL)
- Node.js (any recent version — check with `node --version`)
- Git (optional, only for the git backup feature)

---

## Installation

### Step 1 — Download the script

```bash
mkdir -p ~/.claude/claude-usage-stats
curl -fsSL https://raw.githubusercontent.com/lucasmm96/claude-usage-stats/master/scripts/claude-usage-stats.sh \
  -o ~/.claude/claude-usage-stats/claude-usage-stats.sh
chmod +x ~/.claude/claude-usage-stats/claude-usage-stats.sh
```

Or clone the repo and copy manually:

```bash
git clone https://github.com/lucasmm96/claude-usage-stats.git
mkdir -p ~/.claude/claude-usage-stats
cp claude-usage-stats/scripts/claude-usage-stats.sh ~/.claude/claude-usage-stats/
chmod +x ~/.claude/claude-usage-stats/claude-usage-stats.sh
```

### Step 2 — Register the hook in Claude Code settings

Open (or create) `~/.claude/settings.json` and add the `statusLine` key:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/claude-usage-stats/claude-usage-stats.sh",
    "refreshInterval": 10
  }
}
```

If the file already has other settings, just add the `"statusLine"` block alongside them.

`refreshInterval` re-runs the hook every N seconds in addition to event-driven updates. Without it, a session rename is only captured after the next response; with it, renames reach the log (and the report) within N seconds.

**On Windows:** make sure you're using the Git Bash path style. The command above works as-is in Git Bash. If you're on WSL, use the Linux home path instead.

### Step 3 — Verify

Start a Claude Code session and send any message. After the first response, you should see at the bottom:

```
Model: Sonnet 4.6 | Context: 42% | Tokens: 109.0k
```

The log file is created automatically at `~/.claude/claude-usage-stats/claude-usage-stats-log.json`.

---

## Report page

The report page visualizes your session history: per-exchange token breakdown (input, cache read, cache write, output), context usage timeline, compact events, and aggregate stats.

**Hosted version:** `https://claude-usage-stats.vercel.app`

Or download/clone this repo and open `report/index.html` directly in any browser — no server needed.

### Option A — Load a local file

Click **Load file** and select your `~/.claude/claude-usage-stats/claude-usage-stats-log.json`.

### Option B — Load from a URL

Paste any raw JSON URL into the URL field and click **Load URL**. Works with public GitHub raw URLs:

```
https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/sessions.json
```

You can also append `?data=<url>` to the page URL to auto-load on open.

### Option C — Connect to a private GitHub repo

Click **🔒 Private repo** in the header. A modal will ask for:

| Field | Description |
|---|---|
| Personal Access Token | A GitHub PAT with `Contents: Read-only` on your repo |
| Repository | `owner/repo` (e.g. `lucasmm96/my-usage-stats-backup`) |
| File path | Path to the JSON file inside the repo (default: `sessions.json`) |

The PAT is saved to `localStorage` and never sent anywhere other than `api.github.com`. To generate one: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → select your repo → Contents: Read-only.

### Option D — Connect to the database

Click **🗄 Database** in the header. A modal will ask for:

| Field | Description |
|---|---|
| API URL | Base URL of your deployed API (leave blank if the report and API share the same domain) |
| API Key | The `API_KEY` you configured in the Vercel environment |

Click **Connect** — the report fetches from `GET /api/sessions` and renders your full session history. Credentials are saved to `localStorage` and used to auto-load on the next page open. Auto-refresh runs every 60 seconds.

### Pricing

Click **$ Pricing** in the header to configure token prices per model (USD per million tokens). Once configured, an **Est. Cost** stat appears in the summary bar. Prices are saved in `localStorage`.

### Profiles

Tag sessions with a profile name by setting `CLAUDE_USAGE_PROFILE` in your environment:

```bash
export CLAUDE_USAGE_PROFILE="work"
```

Or inline in `settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "CLAUDE_USAGE_PROFILE=work bash ~/.claude/claude-usage-stats/claude-usage-stats.sh"
  }
}
```

When the log contains multiple profiles, the report shows a filter bar with one button per profile, derived dynamically from the loaded data.

### Auto-refresh

When loading from a URL, private repo, or database, the report polls for changes every 60 seconds and re-renders automatically when new data is available.

---

## Optional: database backend (API + Neon)

The script can upload your log to a PostgreSQL database after each response via a Vercel serverless API. This runs in the background and does not affect the status line display.

### How it works

```
claude-usage-stats.sh
  ├── writes ~/.claude/claude-usage-stats/claude-usage-stats-log.json  (always, primary)
  ├── git commit+push to backup repo             (if BACKUP_REPO configured)
  └── curl POST /api/ingest                      (if API_URL configured, background)

https://claude-usage-stats.vercel.app/
  ├── /             → report SPA (static)
  ├── /api/ingest   → serverless function (POST)
  └── /api/sessions → serverless function (GET)
```

### Deploy your own instance

See **[docs/api-deployment.md](docs/api-deployment.md)** for the full setup guide: Neon database, Vercel deploy, environment variables, and migration of historical data.

### Configure the hook

Add to `~/.claude/claude-usage-stats/backup.conf`:

```bash
API_URL="https://your-deployment.vercel.app"
API_KEY="your-api-key"
```

If `API_URL` is not set, the upload block is skipped silently.

---

## Optional: private git repo backup

The script can also commit and push your log to a private git repository after each response.

### Setup

Create a private repo on GitHub, clone it locally, then create `~/.claude/claude-usage-stats/backup.conf`:

```bash
BACKUP_REPO="$HOME/your-local-clone"   # absolute path to the local clone
BACKUP_BRANCH="main"
BACKUP_FILE="sessions.json"
BACKUP_PUSH_INTERVAL=60                # min seconds between pushes
```

Auth uses your existing git credentials — no credentials go in the config file.

---

## Session renaming

When you rename a session in the Claude Code UI (or use `--title`), the new name arrives in the status line payload on the next hook call. With `refreshInterval` configured, that happens within seconds even without a new response; the transcript scan remains as fallback.

---

## Troubleshooting

**Nothing appears after a response:**
- Verify Node.js is on your PATH: `node --version`
- Run the script manually: `echo '{}' | bash ~/.claude/claude-usage-stats/claude-usage-stats.sh`
- Check that `settings.json` is valid JSON

**Context shows `0%` permanently:**
- One `0%` on the very first exchange after startup is normal
- `42~%` after `/compact` is expected — the `~` disappears on the next exchange

**Token count resets on `--resume`:**
- You may have an older version of the script that used `$PPID` instead of `session_id`. Re-copy the script from this repo.

**Backup not pushing:**
- Check that `BACKUP_REPO` points to a directory with a `.git` folder
- Try pushing manually: `cd ~/your-local-clone && git push`

**API upload not working:**
- Check `API_URL` and `API_KEY` are set in `~/.claude/claude-usage-stats/backup.conf`
- Test manually: `curl -H "Authorization: Bearer $API_KEY" $API_URL/api/sessions`
- Check Vercel function logs for runtime errors

**Report shows `401 Unauthorized`:**
- The API key in the report modal doesn't match the `API_KEY` in Vercel env vars

---

## Log format

See **[docs/log-format.md](docs/log-format.md)** for the full JSON schema.

An anonymized example is at **[examples/sessions.example.json](examples/sessions.example.json)**.

---

## How it works (internals)

Claude Code calls `statusLine.command` after every response, piping a JSON payload to stdin. The script runs an inline Node.js one-liner that:

1. Reads the existing log file
2. Finds or creates the session entry by `session_id`
3. Uses the live `session_name` from the payload, falling back to new transcript bytes for custom-title renames
4. Detects compact events (cumulative totals decrease)
5. Deduplicates duplicate hook calls (streaming artifacts)
6. Appends the exchange entry and writes the file under a lock, with an atomic replace
7. Outputs a tab-separated string that the bash layer formats for display

The bash layer then optionally runs a git commit/push and an API upload in parallel background subshells.

See **[docs/setup.md](docs/setup.md)** for a deeper technical explanation.

---

## License

MIT
