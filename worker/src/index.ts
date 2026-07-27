// Telegram managed-bot pairing service (Cloudflare Worker + Durable Objects).
//
// Mediates QR onboarding between a relay instance and Telegram's Managed Bots
// API (Bot API 9.6+): the relay mints a pairing here, the user scans a QR that
// deep-links into Telegram's native "create bot" confirmation, Telegram then
// notifies the manager bot (webhook below), and this worker fetches the child
// bot's token so the relay can collect it on its next poll.
//
// Pairing state lives in a Durable Object (one per pairing) because it must be
// strongly consistent: with KV, the relay's 2s polls hit a 60s edge cache and
// the user stares at "waiting" long after the token arrived. KV is kept only
// for best-effort rate limiting, where staleness is fine.
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
// Correlation happens through the generated username: the pairing id doubles
// as the slug embedded in assistant_<slug>_bot, so the managed_bot update
// alone identifies the pairing (no lookup table needed).

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

type DurableObjectId = { toString(): string };
type DurableObjectStub = { fetch(req: Request): Promise<Response> };
type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};
type DurableObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
};
type DurableObjectState = { storage: DurableObjectStorage };

export interface Env {
  PAIRING: DurableObjectNamespace;
  /** Rate limiting only — pairing state lives in Durable Objects. */
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
// 8 chars from a 32-symbol alphabet = 40 bits of entropy — still unguessable,
// since testing a guess requires creating a real bot (Telegram caps ~20 per
// account) inside the 5-minute pairing window. Kept short because the
// username is permanent; full username is 10 + 8 + 4 = 22 chars.
const SLUG_LENGTH = 8;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** How long a pairing can be scanned/claimed. */
const PAIRING_TTL_SECONDS = 300;
// Keep the record around after expiry/claim so late polls get a truthful 410
// instead of a confusing 404; the alarm wipes the object after this.
const RECORD_RETENTION_SECONDS = 1800;

const RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_BOT_NAME = 'My Personal Assistant';

type Pairing = {
  id: string; // doubles as the username slug
  poll_token: string;
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

/** One pairing's lifecycle, strongly consistent. Addressed by slug. */
export class PairingObject {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const rec = await this.state.storage.get<Pairing>('rec');

    if (path === '/create' && req.method === 'POST') {
      if (rec) return json({ error: 'already_exists' }, 409);
      const fresh = (await req.json()) as Pairing;
      await this.state.storage.put('rec', fresh);
      await this.state.storage.setAlarm(
        Date.parse(fresh.expires_at) + RECORD_RETENTION_SECONDS * 1000
      );
      return json({ ok: true }, 201);
    }

    if (path === '/status' && req.method === 'GET') {
      if (!rec) return json({ error: 'not_found' }, 404);
      const auth = req.headers.get('Authorization') || '';
      if (auth !== `Bearer ${rec.poll_token}`) return json({ error: 'unauthorized' }, 401);

      if (rec.status === 'claimed') return json({ error: 'claimed' }, 410);
      if (rec.status === 'error') {
        return json({ error: rec.error || 'telegram_token_fetch_failed' }, 502);
      }
      if (rec.status === 'waiting') {
        if (Date.now() > Date.parse(rec.expires_at)) return json({ error: 'expired' }, 410);
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
      await this.state.storage.put('rec', rec);
      return json(payload);
    }

    if (path === '/complete' && req.method === 'POST') {
      if (!rec) return json({ error: 'not_found' }, 404);
      if (rec.status !== 'waiting') return json({ error: 'not_waiting', status: rec.status }, 409);
      if (Date.now() > Date.parse(rec.expires_at)) return json({ error: 'expired' }, 410);
      const body = (await req.json()) as {
        token?: string;
        bot_username?: string;
        owner_user_id?: number;
        error?: string;
      };
      if (body.token) {
        rec.status = 'ready';
        rec.token = body.token;
        rec.bot_username = body.bot_username;
        if (typeof body.owner_user_id === 'number' && body.owner_user_id > 0) {
          rec.owner_user_id = body.owner_user_id;
        }
      } else {
        rec.status = 'error';
        rec.error = body.error || 'telegram_token_fetch_failed';
      }
      await this.state.storage.put('rec', rec);
      return json({ ok: true });
    }

    return json({ error: 'not_found' }, 404);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

function pairingStub(env: Env, id: string): DurableObjectStub {
  return env.PAIRING.get(env.PAIRING.idFromName(id));
}

function doRequest(stub: DurableObjectStub, path: string, init?: RequestInit): Promise<Response> {
  return stub.fetch(new Request(`https://pairing${path}`, init));
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
    id: slug,
    poll_token: randomString(32),
    suggested_username: `${USERNAME_PREFIX}${slug}${USERNAME_SUFFIX}`,
    bot_name: botName,
    expires_at: new Date(Date.now() + PAIRING_TTL_SECONDS * 1000).toISOString(),
    status: 'waiting',
  };

  const deepLink =
    `https://t.me/newbot/${encodeURIComponent(env.MANAGER_BOT_USERNAME)}/` +
    `${encodeURIComponent(rec.suggested_username)}?name=${encodeURIComponent(botName)}`;

  const created = await doRequest(pairingStub(env, slug), '/create', {
    method: 'POST',
    body: JSON.stringify(rec),
  });
  if (!created.ok) return json({ error: 'pairing_create_failed' }, 500);

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
  const res = await doRequest(pairingStub(env, id), '/status', {
    headers: { Authorization: req.headers.get('Authorization') || '' },
  });
  const body = await res.text();
  let status: string | undefined;
  try {
    const parsed = JSON.parse(body) as { status?: string; error?: string };
    status = parsed.status ?? parsed.error;
  } catch {
    // leave undefined
  }
  console.log(JSON.stringify({ evt: 'poll', pairing_id: id, status: status ?? `http_${res.status}` }));
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
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

  // ManagedBotUpdated.user is "User that created the bot" — i.e. the owner.
  const owner = Number(mb.user?.id ?? mb.owner_user_id);

  let completion: { token?: string; bot_username?: string; owner_user_id?: number; error?: string };
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
    if (!data.ok || !token) throw new Error(data.description || 'empty token');
    completion = {
      token,
      bot_username: username,
      ...(Number.isFinite(owner) && owner > 0 ? { owner_user_id: owner } : {}),
    };
  } catch (e) {
    console.log(
      JSON.stringify({
        evt: 'token_fetch_failed',
        pairing_id: match[1],
        error: e instanceof Error ? e.message : String(e),
      })
    );
    completion = { error: 'telegram_token_fetch_failed' };
  }

  const done = await doRequest(pairingStub(env, match[1]), '/complete', {
    method: 'POST',
    body: JSON.stringify(completion),
  });
  console.log(
    JSON.stringify({
      evt: 'pairing_updated',
      pairing_id: match[1],
      status: completion.token ? 'ready' : 'error',
      accepted: done.ok,
      has_owner: Boolean(completion.owner_user_id),
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
      if (hookMatch[1] !== env.WEBHOOK_SECRET) return json({ error: 'unauthorized' }, 401);
      return handleWebhook(env, req);
    }

    return json({ error: 'not_found' }, 404);
  },
};
