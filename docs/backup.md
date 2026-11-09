# Private Repo Backup

The script can automatically commit and push your session log to a private git repository after each Claude Code response. This runs in the background and is completely transparent — it does not affect the status line display or add any delay.

## How it works

1. You clone a private git repo to a local path
2. You create `~/.claude/claude-usage-stats/backup.conf` pointing to that path
3. The script writes the JSON log directly into the repo folder
4. After each write, a background process does `git add + commit`
5. A push happens at most once every 10 minutes (configurable)

Authentication uses whatever git credentials you already have configured (SSH key or Windows Credential Manager) — no credentials go in the config file.

## Setup

**Step 1 — Create a private repo on GitHub** (or any git host).

**Step 2 — Clone it locally:**

```bash
git clone git@github.com:YOUR_USERNAME/claude-stats-private.git ~/claude-stats
```

**Step 3 — Create the config file** at `~/.claude/claude-usage-stats/backup.conf`:

```bash
BACKUP_REPO="$HOME/claude-stats"   # absolute path to the clone
BACKUP_BRANCH="main"
BACKUP_FILE="sessions.json"
BACKUP_PUSH_INTERVAL=60            # seconds between pushes (60 = 1 min; lower = fresher report)
```

**Step 4 — First run:**

Start a Claude Code session. After the first response, the script creates `sessions.json` inside `~/claude-stats/` and makes the first commit. After `BACKUP_PUSH_INTERVAL` seconds, it pushes to the remote.

You can also push manually at any time:

```bash
cd ~/claude-stats && git push
```

## Viewing in the report

If your backup repo is private, you can still view the report locally:

1. Open `report/index.html` in your browser
2. Click **Load file**
3. Navigate to `~/claude-stats/sessions.json`

If you want to host the report on GitHub Pages and load data from your private repo, you can:
- Make the backup repo public (simplest)
- Or pass the raw URL via the `?data=` parameter if the repo is public

## Notes

- The script does not push on every response — only commits. Pushes are throttled to once per `BACKUP_PUSH_INTERVAL` seconds. The report reads the pushed file, so its freshness is bounded by this interval.
- If a push fails (no internet, auth issue), it is silently retried next time the interval elapses.
- The `.last_push` file inside the repo tracks the last push timestamp.
- If `BACKUP_REPO` is set but the directory does not contain a `.git` folder, the script falls back to `~/.claude/claude-usage-stats/claude-usage-stats-log.json` silently.
