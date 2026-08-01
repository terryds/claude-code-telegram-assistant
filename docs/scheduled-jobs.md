# Scheduled watcher jobs — full contract

How to create recurring checks ("watch X", "alert me when…") as **jobs**: the
relay runs a script you write on a cron schedule and delivers its stdout to
the user's Telegram. Read this whole file before writing or registering one.
(The always-on trigger rules live in `AGENTS.md`; this file is the detail.)

## The cost ladder — pick the cheapest tier that works

1. **Pure script — free, the default.** The check is deterministic: price vs
   threshold, HTTP status, "does this string appear on the page", disk usage,
   RSS has a new entry. Covers most requests.
2. **Script detects, agent reports — cheap.** Detection is deterministic but
   the report needs judgment (e.g. "tell me when the changelog updates *and
   summarize it*"). The script does the cheap check every firing; only when
   it triggers does it shell out to
   `claude -p '<self-contained prompt>' --permission-mode bypassPermissions`
   and print the result. Costs a billed turn only when something happened.
3. **Agent check — expensive, last resort.** The check itself needs judgment
   ("does the issue tracker look on fire?"). The script is just the
   `claude -p` call. Tell the user every firing bills an agent turn.

## Setting one up

```bash
mkdir -p data/jobs/btc-alert          # 1. write data/jobs/btc-alert/run.ts
bun data/jobs/btc-alert/run.ts        # 2. test it — run it directly first
bin/job add --name btc-alert --schedule "*/15 * * * *" \
  --desc "Alert when BTC drops below \$50k" data/jobs/btc-alert/run.ts   # 3. register
```

## The job contract

- **stdout is the message.** Non-empty stdout (exit 0) is sent to the user's
  Telegram as rich Markdown; empty stdout means "nothing to report" and sends
  nothing. Never call `bin/notify` from a job script.
- **Prefer Bun scripts** (`run.ts` — `fetch` + `JSON` beat `curl | jq`);
  `.sh` runs under bash. The script runs with cwd = its own directory and a
  10-minute timeout (a timed-out run counts as a failure).
- **State:** for "compared to last time" checks, read/write `$STATE_FILE`
  (= `data/jobs/<name>/state.json`). `$JOB_NAME` and `$JOB_DIR` are also set.
  Alert on *transitions* (crossed the threshold), not on every firing while
  the condition holds — nobody wants the same warning every 15 minutes.
- **Failures:** non-zero exit is recorded (visible in `/jobs` and the
  dashboard); after 3 consecutive failures the relay warns the user once,
  then stays quiet until the job succeeds again.
- **Schedules are UTC** (5-field cron, `Bun.cron` semantics) — convert the
  user's local time before registering (check the host TZ with `date +%z`),
  and confirm the time back to the user in *their* local time.

## Example tier-1 watcher (edge-triggered threshold alert)

```ts
// data/jobs/btc-alert/run.ts — message only when BTC *crosses* below $50k
const THRESHOLD = 50_000;
const r = await fetch(
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
);
const price: number = (await r.json()).bitcoin.usd;
const state = await Bun.file(process.env.STATE_FILE!).json().catch(() => ({ below: false }));
const below = price < THRESHOLD;
if (below && !state.below) {
  console.log(`🔻 **Bitcoin dropped below $${THRESHOLD.toLocaleString()}** — now $${price.toLocaleString()}`);
}
await Bun.write(process.env.STATE_FILE!, JSON.stringify({ below, price }));
```

## Managing jobs

`bin/job list | run <name> | remove <name> | enable <name> | disable <name>`
(`run` fires it once now and *does* deliver to Telegram). The user sees jobs
via the `/jobs` Telegram command and the dashboard's Scheduled-jobs card. When
the user asks to stop watching something, `bin/job remove <name>` and delete
`data/jobs/<name>/` if nothing else uses it.

## Raw crontab — only for jobs that must outlive the relay

The relay's scheduler runs in-process, so jobs only fire while the relay is
up (pm2 keeps it up; missed firings get one catch-up run on boot). In the
rare case a check must fire even with the relay down, use system crontab
(`crontab -l` / re-pipe to `crontab -`): resolve absolute paths while your
turn is alive (cron's PATH is nearly empty) and pipe output to `bin/notify`
yourself.
