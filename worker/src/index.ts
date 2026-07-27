// Telegram managed-bot pairing service (Cloudflare Worker + KV).
//
// Mediates QR onboarding between a relay instance and Telegram's Managed Bots
// API (Bot API 9.6+): the relay mints a pairing here, the user scans a QR that
// deep-links into Telegram's native "create bot" confirmation, Telegram then
// notifies the manager bot (webhook below), and this worker fetches the child
// bot's token so the relay can collect it on its next poll.
//
// Wire protocol (compatible with hermes-agent's onboarding client):
//   POST /v1/telegram/pairings            {bot_name?} ->
//     201 {pairing_id, poll_token, suggested_username, deep_link, qr_payload, expires_at}
//   GET  /v1/telegram/pairings/:id        Authorization: Bearer <poll_token> ->
//     200 {status:"waiting", expires_at}
//     200 {status:"ready", token, bot_username, owner_user_id}   (one-time; then "claimed")
//     404 {error:"not_found"} | 410 {error:"expired"|"claimed"} | 401 {error:"unauthorized"}
//   POST /webhook/:secret                 Telegram webhook for the manager bot
//
// Correlation happens through the generated username: the pairing slug is
// embedded as assistant_<slug>_bot, so the managed_bot update alone identifies
// the pairing (no state needed on Telegram's side).

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export interface Env {
  PAIRINGS: KVNamespace;
  /** Bot token of the manager bot (create once via BotFather; enable Bot Management Mode). */
  MANAGER_BOT_TOKEN: string;
  /** Username of the manager bot, without the @ (goes into the deep link). */
  MANAGER_BOT_USERNAME: string;
  /** Random secret embedded in the webhook path registered with setWebhook. */
  WEBHOOK_SECRET: string;
}

const USERNAME_PREFIX = 'assistant_';
const USERNAME_SUFFIX = '_bot';
// 16 chars from a 32-symbol alphabet = 80 bits of entropy; the full username
// (10 + 16 + 4 = 30 chars) stays under Telegram's 32-char cap.
const SLUG_LENGTH = 16;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** How long a pairing can be scanned/claimed. */
const PAIRING_TTL_SECONDS = 300;
// Keep the KV record around longer than the pairing itself so polls after
// expiry/claim get a truthful 410 instead of a confusing 404.
const KV_TTL_SECONDS = 1800;

const RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_BOT_NAME = 'My Personal Assistant';

type Pairing = {
  id: string;
  poll_token: string;
  slug: string;
  suggested_username: string;
  bot_name: string;
  expires_at: string;
  status: 'waiting' | 'ready' | 'claimed' | 'error';
  token?: string;
  bot_username?: string;
  owner_user_id?: number;
  error?: string;
};

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // 256 % 32 === 0, so the modulo introduces no bias.
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function loadPairing(env: Env, id: string): Promise<Pairing | null> {
  const raw = await env.PAIRINGS.get(`pairing:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pairing;
  } catch {
    return null;
  }
}

async function savePairing(env: Env, rec: Pairing): Promise<void> {
  await env.PAIRINGS.put(`pairing:${rec.id}`, JSON.stringify(rec), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

async function rateLimited(env: Env, req: Request): Promise<boolean> {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `rl:${ip}:${bucket}`;
  const count = Number((await env.PAIRINGS.get(key)) || '0');
  if (count >= RATE_LIMIT_PER_MINUTE) return true;
  // KV is eventually consistent, so this is best-effort — good enough to stop
  // casual abuse; Cloudflare-level rules can cover the rest.
  await env.PAIRINGS.put(key, String(count + 1), { expirationTtl: 120 });
  return false;
}

async function createPairing(env: Env, req: Request): Promise<Response> {
  if (await rateLimited(env, req)) return json({ error: 'rate_limited' }, 429);

  let botName = DEFAULT_BOT_NAME;
  try {
    const body = (await req.json()) as { bot_name?: unknown };
    if (typeof body.bot_name === 'string') {
      const cleaned = body.bot_name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      if (cleaned) botName = cleaned.slice(0, 64);
    }
  } catch {
    // empty body is fine
  }

  const slug = randomString(SLUG_LENGTH);
  const rec: Pairing = {
    id: randomString(16),
    poll_token: randomString(32),
    slug,
    suggested_username: `${USERNAME_PREFIX}${slug}${USERNAME_SUFFIX}`,
    bot_name: botName,
    expires_at: new Date(Date.now() + PAIRING_TTL_SECONDS * 1000).toISOString(),
    status: 'waiting',
  };

  const deepLink =
    `https://t.me/newbot/${encodeURIComponent(env.MANAGER_BOT_USERNAME)}/` +
    `${encodeURIComponent(rec.suggested_username)}?name=${encodeURIComponent(botName)}`;

  await savePairing(env, rec);
  await env.PAIRINGS.put(`slug:${slug}`, rec.id, { expirationTtl: KV_TTL_SECONDS });
  console.log(
    JSON.stringify({
      evt: 'pairing_created',
      pairing_id: rec.id,
      suggested_username: rec.suggested_username,
      expires_at: rec.expires_at,
    })
  );

  return json(
    {
      pairing_id: rec.id,
      poll_token: rec.poll_token,
      suggested_username: rec.suggested_username,
      deep_link: deepLink,
      qr_payload: deepLink,
      expires_at: rec.expires_at,
    },
    201
  );
}

async function pollPairing(env: Env, req: Request, id: string): Promise<Response> {
  const rec = await loadPairing(env, id);
  console.log(JSON.stringify({ evt: 'poll', pairing_id: id, status: rec?.status ?? 'not_found' }));
  if (!rec) return json({ error: 'not_found' }, 404);

  const auth = req.headers.get('Authorization') || '';
  if (auth !== `Bearer ${rec.poll_token}`) return json({ error: 'unauthorized' }, 401);

  if (rec.status === 'claimed') return json({ error: 'claimed' }, 410);
  if (rec.status === 'error') {
    return json({ error: rec.error || 'telegram_token_fetch_failed' }, 502);
  }
  if (rec.status === 'waiting') {
    if (Date.now() > Date.parse(rec.expires_at)) {
      await env.PAIRINGS.delete(`slug:${rec.slug}`);
      return json({ error: 'expired' }, 410);
    }
    return json({ status: 'waiting', expires_at: rec.expires_at });
  }

  // ready — serve the token exactly once, then remember it was claimed.
  const payload = {
    status: 'ready',
    token: rec.token,
    bot_username: rec.bot_username,
    owner_user_id: rec.owner_user_id,
  };
  rec.status = 'claimed';
  delete rec.token;
  await savePairing(env, rec);
  await env.PAIRINGS.delete(`slug:${rec.slug}`);
  return json(payload);
}

async function handleWebhook(env: Env, req: Request): Promise<Response> {
  if (!env.MANAGER_BOT_TOKEN) {
    console.log(JSON.stringify({ evt: 'webhook_error', reason: 'manager_token_not_configured' }));
    return json({ error: 'telegram_manager_bot_token_not_configured' }, 500);
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    console.log(JSON.stringify({ evt: 'webhook_ignored', reason: 'unparseable_body' }));
    return json({ ok: true });
  }

  // Breadcrumb: which update types Telegram is actually sending us (never log
  // the full payload — some update types can carry message content).
  console.log(
    JSON.stringify({
      evt: 'webhook_update',
      update_id: update?.update_id,
      keys: Object.keys(update ?? {}).filter((k) => k !== 'update_id'),
    })
  );

  // Only managed_bot updates matter here (setWebhook is registered with
  // allowed_updates=["managed_bot"], but be defensive anyway).
  const mb = update?.managed_bot;
  const bot = mb?.bot ?? mb;
  const username: string = String(bot?.username || '');
  const match = username
    .toLowerCase()
    .match(new RegExp(`^${USERNAME_PREFIX}([a-z0-9]+)${USERNAME_SUFFIX}$`));
  if (!mb || !bot?.id || !match) {
    console.log(
      JSON.stringify({
        evt: 'webhook_ignored',
        reason: !mb ? 'no_managed_bot_field' : !bot?.id ? 'no_bot_id' : 'username_mismatch',
        managed_bot_keys: mb ? Object.keys(mb) : null,
        bot_username: username || null,
      })
    );
    return json({ ok: true });
  }

  const pairingId = await env.PAIRINGS.get(`slug:${match[1]}`);
  const rec = pairingId ? await loadPairing(env, pairingId) : null;
  if (!rec || rec.status !== 'waiting') {
    console.log(
      JSON.stringify({
        evt: 'webhook_ignored',
        reason: !pairingId ? 'slug_not_found' : !rec ? 'pairing_record_missing' : 'pairing_not_waiting',
        slug: match[1],
        status: rec?.status ?? null,
      })
    );
    return json({ ok: true });
  }
  if (Date.now() > Date.parse(rec.expires_at)) {
    console.log(JSON.stringify({ evt: 'webhook_ignored', reason: 'pairing_expired', pairing_id: rec.id }));
    return json({ ok: true });
  }

  // ManagedBotUpdated.user is "User that created the bot" — i.e. the owner.
  const ownerRaw = mb.user?.id ?? mb.owner_user_id;
  const owner = Number(ownerRaw);

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.MANAGER_BOT_TOKEN}/getManagedBotToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A bot's id is a user id — the method takes user_id, not bot_id.
        body: JSON.stringify({ user_id: bot.id }),
      }
    );
    const data = (await res.json()) as {
      ok: boolean;
      result?: { token?: string } | string;
      description?: string;
    };
    const token = typeof data.result === 'string' ? data.result : data.result?.token;
    // Log the Telegram verdict, never the token itself.
    console.log(
      JSON.stringify({
        evt: 'token_fetch',
        http_status: res.status,
        tg_ok: data.ok,
        got_token: Boolean(token),
        description: data.description ?? null,
      })
    );
    if (!data.ok || !token) throw new Error('empty token');
    rec.status = 'ready';
    rec.token = token;
    rec.bot_username = username;
    if (Number.isFinite(owner) && owner > 0) rec.owner_user_id = owner;
  } catch (e) {
    console.log(
      JSON.stringify({
        evt: 'token_fetch_failed',
        pairing_id: rec.id,
        error: e instanceof Error ? e.message : String(e),
      })
    );
    rec.status = 'error';
    rec.error = 'telegram_token_fetch_failed';
  }
  await savePairing(env, rec);
  console.log(
    JSON.stringify({
      evt: 'pairing_updated',
      pairing_id: rec.id,
      status: rec.status,
      has_owner: Boolean(rec.owner_user_id),
    })
  );
  return json({ ok: true });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/v1/telegram/pairings' && req.method === 'POST') {
      return createPairing(env, req);
    }

    const pollMatch = path.match(/^\/v1\/telegram\/pairings\/([a-z0-9]+)$/);
    if (pollMatch && req.method === 'GET') {
      return pollPairing(env, req, pollMatch[1]);
    }

    const hookMatch = path.match(/^\/webhook\/([^/]+)$/);
    if (hookMatch && req.method === 'POST') {
      if (hookMatch[1] !== env.WEBHOOK_SECRET) {
        console.log(JSON.stringify({ evt: 'webhook_rejected', reason: 'bad_secret' }));
        return json({ error: 'unauthorized' }, 401);
      }
      return handleWebhook(env, req);
    }

    console.log(JSON.stringify({ evt: 'unmatched_route', method: req.method, path }));
    return json({ error: 'not_found' }, 404);
  },
};
