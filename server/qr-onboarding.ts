// QR onboarding via Telegram managed bots (Bot API 9.6+).
//
// The dashboard shows a QR code that deep-links into Telegram's native
// "create bot" confirmation; a hosted pairing service (see worker/) receives
// the managed_bot update, fetches the child bot's token, and this module
// collects it on the next poll. Because the pairing also reports which user
// confirmed the creation — and a private chat's id equals that user's id —
// one scan both saves the token and links the chat.
//
// Security: the pairing service's poll_token and the bot token itself stay in
// this process; the browser only ever sees pairing metadata and the final
// getMe result.

import { getSetting, setSetting, deleteSetting } from './db.ts';
import { getBotInfo, sendTelegram, type BotInfo } from './telegram.ts';
import { setRelayEnabled, applyBotCommands } from './tg-listener.ts';

// One deployed instance of worker/ serves every install; self-hosters can
// point elsewhere with TELEGRAM_ONBOARDING_URL or the onboarding_service_url
// setting. Update this default after deploying your own worker.
const DEFAULT_ONBOARDING_URL = 'https://relay-telegram-setup.terrydjony.workers.dev';

const DEFAULT_TTL_MS = 300_000;
const UPSTREAM_TIMEOUT_MS = 10_000;

export type QrPairingPublic = {
  pairing_id: string;
  suggested_username: string;
  deep_link: string;
  qr_payload: string;
  expires_at: string;
};

export type QrPollResult =
  | { status: 'waiting'; expires_at: string }
  | { status: 'ready'; bot: BotInfo; chat_id: string | null }
  | { status: 'expired' }
  | { status: 'claimed' }
  | { status: 'error'; error: string };

type StoredPairing = {
  id: string;
  pollToken: string;
  expiresAt: number;
  done?: { bot: BotInfo; chatId: string | null };
};

const pairings = new Map<string, StoredPairing>();

function baseUrl(): string {
  const url =
    process.env.TELEGRAM_ONBOARDING_URL ||
    getSetting('onboarding_service_url') ||
    DEFAULT_ONBOARDING_URL;
  return url.trim().replace(/\/+$/, '');
}

function prune(): void {
  const now = Date.now();
  for (const [id, rec] of pairings) {
    // Keep completed/expired records a while so late polls answer sensibly.
    if (now > rec.expiresAt + 600_000) pairings.delete(id);
  }
}

function parseExpiry(value: unknown): number {
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) return ts;
  }
  return Date.now() + DEFAULT_TTL_MS;
}

function friendlyWorkerError(code: string): string {
  if (code === 'telegram_token_fetch_failed') {
    return "Telegram didn't hand over the new bot's token. Generate a new QR code, or use the BotFather method instead.";
  }
  if (code === 'telegram_manager_bot_token_not_configured') {
    return 'The QR setup service is misconfigured (no manager bot token). Use the BotFather method instead.';
  }
  return `QR setup failed: ${code}`;
}

export async function startQrPairing(): Promise<
  { ok: true; pairing: QrPairingPublic } | { ok: false; error: string }
> {
  prune();
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/v1/telegram/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ bot_name: 'My Personal Assistant' }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      error: 'The QR setup service is unreachable. Try again shortly, or use the BotFather method instead.',
    };
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    const detail = data && typeof data.error === 'string' ? `: ${data.error}` : '';
    return { ok: false, error: `The QR setup service rejected the request${detail}.` };
  }
  const { pairing_id, poll_token, suggested_username, deep_link } = data;
  if (
    typeof pairing_id !== 'string' ||
    typeof poll_token !== 'string' ||
    typeof suggested_username !== 'string' ||
    typeof deep_link !== 'string'
  ) {
    return { ok: false, error: 'The QR setup service returned an unexpected response.' };
  }
  const expiresAt = parseExpiry(data.expires_at);
  pairings.set(pairing_id, { id: pairing_id, pollToken: poll_token, expiresAt });
  return {
    ok: true,
    pairing: {
      pairing_id,
      suggested_username,
      deep_link,
      qr_payload: typeof data.qr_payload === 'string' ? data.qr_payload : deep_link,
      expires_at: new Date(expiresAt).toISOString(),
    },
  };
}

/** Returns null for an unknown pairing id. */
export async function pollQrPairing(id: string): Promise<QrPollResult | null> {
  prune();
  const rec = pairings.get(id);
  if (!rec) return null;
  if (rec.done) return { status: 'ready', bot: rec.done.bot, chat_id: rec.done.chatId };

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/v1/telegram/pairings/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${rec.pollToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // Transient network trouble — keep the client polling until expiry.
    return waitingOrExpired(rec);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (res.status === 404) {
    pairings.delete(id);
    return { status: 'expired' };
  }
  if (res.status === 410) {
    pairings.delete(id);
    return data?.error === 'claimed' ? { status: 'claimed' } : { status: 'expired' };
  }
  if (res.status === 502 && typeof data?.error === 'string') {
    pairings.delete(id);
    return { status: 'error', error: friendlyWorkerError(data.error) };
  }
  if (!res.ok || !data) return waitingOrExpired(rec);

  if (data.status === 'ready' && typeof data.token === 'string') {
    return applyPairing(rec, data.token, data.owner_user_id);
  }
  if (typeof data.expires_at === 'string') rec.expiresAt = parseExpiry(data.expires_at);
  return waitingOrExpired(rec);
}

function waitingOrExpired(rec: StoredPairing): QrPollResult {
  if (Date.now() > rec.expiresAt) {
    pairings.delete(rec.id);
    return { status: 'expired' };
  }
  return { status: 'waiting', expires_at: new Date(rec.expiresAt).toISOString() };
}

async function applyPairing(
  rec: StoredPairing,
  token: string,
  ownerRaw: unknown
): Promise<QrPollResult> {
  const check = await getBotInfo(token.trim());
  if (!check.ok) {
    pairings.delete(rec.id);
    return { status: 'error', error: `Telegram rejected the new bot's token: ${check.error}` };
  }

  const owner = Number(ownerRaw);
  const chatId = Number.isFinite(owner) && owner > 0 ? String(Math.trunc(owner)) : null;

  setSetting('telegram_bot_token', token.trim());
  if (chatId) {
    // A private chat's id equals the owner's user id, so linking needs no
    // "send a message first" capture step.
    setSetting('telegram_chat_id', chatId);
    setSetting('captured_chat_id', chatId);
    setRelayEnabled(true);
    applyBotCommands().catch(() => {});
    sendTelegram(
      [
        '✅ <b>Bot created &amp; chat linked!</b>',
        '',
        `Chat ID: <code>${chatId}</code>`,
        '',
        'You can now talk to your coding agent here — just say "Hi!"',
      ].join('\n')
    ).catch(() => {});
  } else {
    // No owner reported — token is saved, but the chat still needs the
    // classic capture step. Clear any stale link from a previous bot.
    deleteSetting('telegram_chat_id');
  }

  rec.done = { bot: check.bot, chatId };
  return { status: 'ready', bot: check.bot, chat_id: chatId };
}

export function cancelQrPairing(id: string): void {
  pairings.delete(id);
}

export function clearQrPairings(): void {
  pairings.clear();
}
