# AGENTS.md

Guidance for AI coding agents working in this repo. (Claude Code reads this via
the `@AGENTS.md` import in `CLAUDE.md`.)

This is a single-user, self-hosted relay that forwards Telegram messages to a
coding agent — **Claude Code or Codex** — running on the host, and sends the
reply back. Stack: Bun + React (Vite) + Tailwind + `bun:sqlite`. The active
engine is a global setting (switchable via the dashboard or the `/engine`
Telegram command); engine implementations live behind `server/engine.ts` /
`server/engines.ts`.

## Replying over Telegram

Your final reply is delivered via Telegram's **Rich Messages** API
(`sendRichMessage`, Bot API 10.1+), which renders GitHub-Flavored Markdown
natively. So write normal Markdown: headings, **bold**/_italic_, bullet and
numbered lists, tables, blockquotes, `---` rules, and fenced code blocks with
language tags all display properly, and the per-message limit is ~32k chars
(the relay chunks anything longer on paragraph boundaries).

Two caveats:

- **Prefer bare URLs** for links the user should open. Inline `[text](url)`
  links render, but Telegram shows an "Open this link?" confirmation dialog
  before following them — a bare URL on its own line is one tap:

  ```
  https://example.com/#project/foo
  ```

- If Telegram rejects the rich send (outdated Bot API server, pathological
  markdown), the relay falls back to plain text and your Markdown arrives as
  literal characters — harmless, but don't rely on formatting alone to carry
  meaning (e.g. don't hide the answer in a table cell).

### Never send `localhost` / `0.0.0.0` URLs

The user reads your reply on their phone, not on this host — a URL pointing at
`localhost`, `127.0.0.1`, or `0.0.0.0` (e.g. the bind address a dev server
prints) is dead on arrival. Before sharing a URL to anything running on this
machine, resolve the host's reachable address and substitute it.

**Always prefer the machine's full domain name over an IP address.** Get it
with `hostname -f` and use it in the URL whenever it resolves to a real,
publicly-reachable domain (contains a dot and isn't a bare local name like
`myhost` or `myhost.local`/`.localdomain`):

```bash
hostname -f                      # full domain name — USE THIS if it resolves
```

Only if `hostname -f` yields no usable domain, fall back to an IP:

```bash
curl -s ifconfig.me              # public IP (VPS reachable from anywhere)
hostname -I | awk '{print $1}'   # Linux: first LAN/VPN IP
ipconfig getifaddr en0           # macOS equivalent
```

Prefer whatever the user can actually reach (a VPS's DNS name over its IP; a
Tailscale MagicDNS name over a LAN IP for a home machine), keep the port, e.g.
`http://my-vps.example.com:5173/` — an IP like `http://203.0.113.7:5173/` only
as a last resort, and never `http://0.0.0.0:5173/`.

## Bookmark every newly deployed app

The dashboard's homepage has a **Bookmarks** section — the user's launcher for
navigating between the apps you've built for them. **Whenever the user asks
you to create a new project and it ends up successfully deployed and running
on its own port, add it to the bookmarks** before you finish the turn:

```bash
bin/bookmark "http://$(hostname -f):3001"                    # title/favicon auto-fetched
bin/bookmark --title "My Notes App" "http://$(hostname -f):3001"   # explicit title
```

Rules:

- Use the same reachable-URL rules as for links in replies: full domain name
  from `hostname -f` when it's a real domain, IP only as a last resort —
  never `localhost`.
- Only bookmark apps that are actually up and reachable (the relay fetches
  the page's title and favicon when adding — a dead URL gets neither).
- `bin/bookmark` is idempotent per URL (re-running refreshes the title/icon
  instead of duplicating), works even while the relay is down (direct DB
  fallback), and also supports `--list` and `--remove <url-or-id>` — do that
  cleanup when the user asks to remove a project.
- If the app moves to a different port later, remove the old bookmark and add
  the new one.

Mention in your reply that the app was added to the dashboard's bookmarks.

## Messaging the user proactively (reminders, "tell me later")

The relay is purely reactive: each incoming Telegram message spawns a one-shot
headless run (`claude -p` / `codex exec`), and your process dies the moment
your turn ends. Harness timers (`ScheduleWakeup`, cron tools, background
tasks) will **not** fire after that — never rely on them here.

To push a message to the user's Telegram at any time, use:

```bash
bin/notify "your message"        # or pipe:  some-command | bin/notify
```

It reads the bot token and linked chat id from the relay's settings DB
(`data/app.db`), so it works even while the relay is down. Options:
`--chat <id>` / `--thread <id>` to target a linked group topic, `--md` to
send as a rich message (GitHub-Flavored Markdown — use this when piping
agent output; falls back to plain text if rejected), `--html` for
Telegram-HTML, `--dry-run` to print the request instead of sending. Default
is plain text — safest for arbitrary piped output.

To say something **later**, schedule a detached job that outlives your turn
(same trick safe-update-relay uses). Use an absolute path — resolve it while
your turn is still alive, e.g. `N="$PWD/bin/notify"`:

```bash
# one-off in 2 minutes — survives your process exiting and pm2 restarts,
# but NOT a host reboot; use cron for durable/recurring schedules:
setsid nohup bash -c "sleep 120 && \"$N\" '👋 2 minutes are up'" >/dev/null 2>&1 &
```

For "check X later and tell me" — a real agent turn, not canned text — have
the scheduled job run a fresh headless turn and pipe the result:

```bash
setsid nohup bash -c "sleep 7200 && cd $PWD && claude -p 'Check the deploy status of foo; summarize in 3 lines.' --permission-mode bypassPermissions 2>&1 | \"$N\" --md" >/dev/null 2>&1 &
```

Prefer a fresh session with a self-contained prompt over `--resume`: resuming
the relay's live session from a background job can race with a run the relay
starts at the same moment.

### Recurring checks ("watch X", "alert me when…"): write a script, register a job

When the user asks to watch/monitor/check something on a schedule, do **not**
schedule an agent prompt by default — every `claude -p` firing is a billed
agent turn. Instead, spend one turn (this one) writing a deterministic
watcher script and registering it as a **job** (`bin/job add`): the relay
runs it on a cron schedule and delivers its stdout to the user's Telegram for
free. Escalate only as far up this ladder as the check actually requires:
pure script (free, covers most requests) → script detects + `claude -p` only
on trigger (bills a turn only when something happened) → scheduled agent
check (last resort — warn the user it bills every firing).

**Before writing or registering a job, read `docs/scheduled-jobs.md`** — it
has the full contract (stdout-is-the-message, `$STATE_FILE`, UTC schedules,
failure semantics), a worked example, and the `bin/job` management commands.

**Always close the loop in your reply** after creating a job: its name, the
schedule in the user's own terms and timezone, exactly what triggers a
message ("you'll only hear from it when…"), and that saying e.g. "remove the
btc-alert job" stops it.

## Updating the relay itself

Never plain `pm2 restart` from a Telegram-relayed turn — it kills the process
hosting your own run mid-reply. Update with the detached helper (pings the
chat when done; a failed pull/build aborts before the restart):

```bash
setsid nohup ~/claude-code-telegram-assistant/bin/safe-update-relay >/dev/null 2>&1 < /dev/null &
```

Env config (`RELAY_PROCESS_NAME`, `RELAY_REPO_DIR`), setup/install steps
(`bin/doctor` / `bin/install`), and legacy-name migration notes are in the
README ("VPS setup" and "Updating").
