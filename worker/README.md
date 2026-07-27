# Telegram setup worker (managed-bot QR onboarding)

A tiny Cloudflare Worker that lets relay instances onboard Telegram **without
BotFather**: the dashboard shows a QR code, the user scans it, Telegram's
native "create bot" confirmation appears, and the freshly minted bot token
flows back to the relay automatically — via Telegram's Managed Bots feature
(Bot API 9.6+).

One instance of this worker (plus one **manager bot**) serves every install of
the relay. You deploy it once; relay instances point at it via
`TELEGRAM_ONBOARDING_URL` (or the baked-in default in
`server/qr-onboarding.ts`).

## How it works

```
relay ── POST /v1/telegram/pairings ──▶ worker  (mints pairing + suggested username)
relay ◀─ {pairing_id, poll_token, deep_link, qr_payload, expires_at}
user scans QR ──▶ t.me/newbot/<ManagerBot>/assistant_<slug>_bot?name=…
Telegram ── managed_bot update ──▶ worker webhook
worker ── getManagedBotToken ──▶ Telegram   (child bot token)
relay ── GET /v1/telegram/pairings/:id (Bearer poll_token) ──▶ {status:"ready", token, owner_user_id}
```

The pairing slug is embedded in the bot username (`assistant_<slug>_bot`,
40 bits of entropy — plenty, since testing a guess requires creating a real
bot), which is how the webhook correlates a bot creation back to a pairing. Pairings expire after 5 minutes; the token is served exactly
once (subsequent polls get `410 claimed`).

## Deploy

1. **Create the manager bot** (one-time BotFather interaction — the last one
   anyone needs): message [@BotFather](https://t.me/BotFather), `/newbot`,
   pick a name/username (e.g. `MyRelaySetupBot`), save the token. Then enable
   **Bot Management Mode** for it in BotFather's bot settings so it can manage
   child bots and receive `managed_bot` updates.

2. **Create the KV namespace** (used only for rate limiting — pairing state
   lives in Durable Objects, which deploy automatically) and drop its id into
   `wrangler.toml`:

   ```bash
   cd worker
   wrangler kv namespace create PAIRINGS
   # copy the printed id into wrangler.toml, and set MANAGER_BOT_USERNAME
   ```

3. **Set secrets and deploy:**

   ```bash
   wrangler secret put MANAGER_BOT_TOKEN     # the manager bot's token
   wrangler secret put WEBHOOK_SECRET        # e.g. openssl rand -hex 24
   wrangler deploy
   ```

4. **Register the webhook** for the manager bot (only `managed_bot` updates):

   ```bash
   curl "https://api.telegram.org/bot<MANAGER_BOT_TOKEN>/setWebhook" \
     -d "url=https://<your-worker>.workers.dev/webhook/<WEBHOOK_SECRET>" \
     -d 'allowed_updates=["managed_bot"]'
   ```

5. **Point the relay at it** — either set the deployed URL as
   `DEFAULT_ONBOARDING_URL` in `server/qr-onboarding.ts` (so it ships as the
   default), or per-install via env:

   ```bash
   TELEGRAM_ONBOARDING_URL=https://<your-worker>.workers.dev bun start
   ```

## Smoke test

```bash
BASE=https://<your-worker>.workers.dev
curl -s -X POST $BASE/v1/telegram/pairings -d '{"bot_name":"Test"}' | jq
# open the deep_link on a phone, confirm bot creation, then:
curl -s $BASE/v1/telegram/pairings/<pairing_id> \
  -H "Authorization: Bearer <poll_token>" | jq
```

## Notes

- Pairing state (and, briefly, tokens) lives in one Durable Object per
  pairing — strongly consistent, so the relay sees "ready" on its next poll
  with no KV cache lag. An alarm wipes each object ~30 minutes after expiry;
  nothing is persisted beyond that.
- `POST /v1/telegram/pairings` is rate-limited to 10/minute per IP
  (best-effort, KV-based). Add Cloudflare WAF rules if you need more.
- Failure to fetch a child token surfaces to the relay as
  `telegram_token_fetch_failed` (HTTP 502 on the poll), which the dashboard
  turns into a "fall back to BotFather" message.
