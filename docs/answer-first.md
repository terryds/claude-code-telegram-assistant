# Answer first; never let long work eat the reply

Each Telegram message spawns a one-shot `claude -p` run. Three hard limits
shape what the agent can do inside it:

- A single Bash tool call is killed at **5 minutes** (the relay sets
  `BASH_MAX_TIMEOUT_MS`; `RELAY_BASH_TIMEOUT_MS` changes it, `0` lifts it).
- Any message the user sends while a run is going **kills that run** (auto-stop
  & replace). The replacement prompt carries a relay note with how long the
  killed run had been going and what it was doing, so the agent can answer.
- Background commands die the moment the turn ends.
- The final message is the **only** thing the user receives.

A run that starts a long build in the foreground gets the command killed
and winds down with a stub ("No response requested.") — the user never gets an
answer. The relay's reply guard (`server/reply-guard.ts`) now catches empty or
stub endings and posts a "finished without answering" notice (naming the tool
timeout when it saw one, and stating that the work is **not** still running).
That is damage control; the rules below are the plan.

## Rules

1. **Answer the question before starting anything slow.** If the message
   contains a question answerable now (from what you know, a quick lookup, a
   `git`/`ls`/`curl` call), write that answer into the final reply first, then
   decide whether extra work is needed. Never make the answer wait on a build,
   deploy, test suite, sync, or download.

2. **Anything that might exceed ~5 minutes runs detached.** Builds, full test
   suites, backfills, large downloads, package/model installs, scrapes — start
   them with `setsid nohup` so they outlive the turn, and have the job report
   back with `bin/notify` when it finishes. Resolve absolute paths while the
   turn is alive:

   ```bash
   N="$PWD/bin/notify"
   # Private chat: bin/notify with no target flags reaches the user.
   # Group topic: the context line at the top of the message gives the exact
   # `bin/notify --chat <id> --thread <id>` to use — append it to "$N" below.
   setsid nohup bash -c "
     cd /path/to/project
     if bun run build > build.log 2>&1; then
       \"$N\" '✅ Build finished — ready to test.'
     else
       { echo '❌ Build failed. Last lines:'; tail -20 build.log; } | \"$N\"
     fi
   " >/dev/null 2>&1 < /dev/null &
   ```

   Then say in the reply that it is running detached and will report back,
   with a rough ETA. Do not poll or `sleep` waiting for it.

3. **Never end a turn with a non-answer.** "No response requested.", a bare
   "Done.", or an empty message are failures. If a tool call was killed at its
   time limit, say so and say what you did about it (restarted detached, or
   what the user should decide). With genuinely nothing to add, confirm what
   the user said in one line instead of staying silent.

4. **If a long foreground command is unavoidable** (it must finish before the
   answer exists), send a short interim line first with `bin/notify "…"` so
   the user knows it will take a while, keep the command under the cap
   (`timeout 240 …`), and still write a real final reply even if it got cut
   off.

## What the user sees when it goes wrong anyway

```
⚠️ Claude Code finished without answering
The run ended with "No response requested." instead of a reply.

A command in this run hit the Bash tool time limit and was killed, which is
usually how the answer gets lost. Anything it was doing is not still running.

Ask again and I will answer first; if the task is long, I will run it
detached and report back here when it finishes.
```

The session is still saved, so "ask again" resumes with full context. The
guard matches only whole-message stubs (see `NON_ANSWER_RES`); a real answer
that merely contains the phrase is delivered untouched.
