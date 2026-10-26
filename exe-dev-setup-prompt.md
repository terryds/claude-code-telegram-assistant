# exe.dev Setup Prompt for claude-code-telegram-assistant

Paste this into the **Describe your VM** box at <https://exe.dev/new> (or pass
it via `--prompt` from the terminal) to set up and run the relay. exe.dev's image ships the `claude` CLI, and
you **authenticate them from the dashboard** during onboarding — so this prompt
just gets the relay running and hands you the URL to open. No terminal login.

## The prompt

```
Set up and run the "claude-code-telegram-assistant" project on this VM, then give me the URL to open for onboarding.

It's a single-user, self-hosted relay that forwards Telegram messages to Claude Code running here and sends replies back. Stack: Bun + React/Vite + Tailwind + SQLite. The `claude` CLI is already installed on this image — do NOT reinstall it, and do NOT try to log it in from the terminal. Authentication (subscription sign-in or API key) is done in the dashboard during onboarding.

1. Clone https://github.com/terryds/claude-code-telegram-assistant.git into ~/claude-code-telegram-assistant and cd into it.
2. Run `bin/doctor`. If any core dependency is missing (bun, node, npm, pm2, git, jq, sqlite3, python3), run `bin/install` (idempotent, uses sudo) and re-check. Do NOT touch the agent CLIs. (python3 is needed for Claude's in-dashboard subscription sign-in.)
3. Build: `bun install` then `bun run build`.
4. Start it under pm2 on port 8000 (exe.dev's default exposed port) with bun as the interpreter:
     cd ~/claude-code-telegram-assistant
     PORT=8000 pm2 start server/index.ts --name claude-code-telegram-assistant --interpreter "$(which bun)" --max-restarts 10 --restart-delay 3000
     pm2 save
     pm2 startup   # run the command it prints so it survives reboot
5. Confirm it's listening on 8000 with no errors (`pm2 logs claude-code-telegram-assistant --lines 20`).
6. Tell me the public URL for port 8000 on this VM — that's the dashboard. Use the VM's full domain name (from `hostname -f`, e.g. https://<vm-name>.exe.xyz:8000) — do NOT give me an IP-address URL. I'll finish setup there myself: sign in to Claude Code (subscription, right in the page — or paste an API key), then connect Telegram with a bot token from @BotFather (or the QR-scan option, where Telegram creates the bot for me).

Do NOT set the Telegram bot token or chat ID, and do NOT authenticate the agent CLIs — those all happen in the dashboard onboarding UI.
```

## Run it

**From the exe.dev dashboard (easiest):** open <https://exe.dev/new>, paste the
prompt block above into the **Describe your VM** box, pick the specs (2 CPU /
4 GB / 20 GB disk is plenty), and create the VM. Then open the VM's **Shelley**
menu to follow the agent's progress — you'll see it clone the repo, build, and
start the relay, and that's where it posts the dashboard URL when done.

**Or from a terminal:** save just the contents of the code fence to
`exe-prompt.txt`, then pipe it from stdin:

```bash
ssh exe.dev new --name=coding-relay --cpu=2 --memory=4GB --disk=20GB --prompt=/dev/stdin < exe-prompt.txt
```

## After it reports the URL

Open the dashboard URL the agent gives you (e.g. `https://<vm-name>.exe.xyz:8000`)
and complete onboarding — all in the browser, no terminal:

1. **Authenticate Claude Code.** The page checks the CLI is installed and
   whether it's signed in. If not:
   - **Subscription** — click **Sign in with Claude**, open the link,
     authorize. Done.
   - **API key** — paste an Anthropic key instead.
2. **Connect your Telegram bot.** Paste a token from
   [@BotFather](https://t.me/BotFather) (default), or switch to the **Scan QR
   code** tab — Telegram creates a bot for you and links your chat in one step
   (managed bots; needs a Telegram app that supports it, which not all do yet).
3. **(BotFather method only)** Message your bot once to link your chat.

Then you're on the dashboard and the relay is live.

## Notes

- **The dashboard has no built-in auth, and doesn't need one here.** exe.dev's
  proxy is private by default — opening the URL requires logging in to
  exe.dev. Keep it that way: don't run `share set-public` on this VM (anyone
  who reaches the dashboard can re-onboard and get a shell on it).
- Recommended specs: 2 CPU / 4 GB / 20 GB disk; Ubuntu image (auto-detected).
- Auth (subscription tokens / API keys), bot token, chat link, and session all
  live in `data/app.db` and survive restarts. Keep the agent CLIs current.
- Update later: `cd ~/claude-code-telegram-assistant && git pull && bun install && bun run build && pm2 restart claude-code-telegram-assistant` — or run `bin/safe-update-relay`.
