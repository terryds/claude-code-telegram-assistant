/**
 * Watches the host's Claude sign-in for the one outage the relay can see
 * coming: the OAuth refresh token's hard expiry (see claude-credentials.ts).
 *
 * Hourly (one keychain/file read, no model call) it compares the deadline with
 * now and tells the user over Telegram at three stages — 3 days out, 1 day
 * out, and once it has lapsed — each at most once per deadline. A fresh
 * sign-in moves the deadline, which re-arms the notices. At the "expired"
 * stage it also flips the cached auth status to signed-out, so the dashboard
 * says so before the next message even fails.
 */
import { describeDeadline, readClaudeCredential } from './claude-credentials.ts';
import { getEngineId, getAuthConfig, saveAuthProbe, usesHostLogin } from './engine.ts';
import { addPendingContext, getSetting, logMessage, setSetting } from './db.ts';
import { getTelegramConfig, sendTelegramRich } from './telegram.ts';
import { getDashboardUrl } from './dashboard-url.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;
const NOTICE_KEY = 'auth_expiry_notice';

export type ExpiryStage = '3d' | '1d' | 'expired';
const RANK: Record<ExpiryStage, number> = { '3d': 1, '1d': 2, expired: 3 };

/** Which notice (if any) applies to a deadline right now. */
export function expiryStage(deadline: number, now: number): ExpiryStage | null {
  const left = deadline - now;
  if (left <= 0) return 'expired';
  if (left <= DAY_MS) return '1d';
  if (left <= 3 * DAY_MS) return '3d';
  return null;
}

/** True if `stage` for `deadline` has not been announced yet (and records it). */
export function claimNotice(deadline: number, stage: ExpiryStage): boolean {
  const prev = getSetting(NOTICE_KEY);
  if (prev) {
    const [pd, ps] = prev.split(':');
    if (pd === String(deadline) && ps in RANK && RANK[ps as ExpiryStage] >= RANK[stage]) {
      return false;
    }
  }
  setSetting(NOTICE_KEY, `${deadline}:${stage}`);
  return true;
}

/** The re-auth steps, as Markdown lines — bare URL so it's one tap on a phone. */
export function signInStepsMarkdown(): string[] {
  const url = getDashboardUrl();
  return [
    url ? `1. Open the dashboard:\n${url}/#auth` : '1. Open the dashboard → **Claude Code authentication**',
    '2. Tap **Sign in with Claude** and authorize (the dashboard finishes on its own).',
  ];
}

function noticeMarkdown(stage: ExpiryStage, deadline: number): string {
  const when = describeDeadline(deadline);
  const left = stage === '3d' ? 'in 3 days' : 'tomorrow';
  if (stage === 'expired') {
    return [
      `⛔ **Claude Code is signed out** — the sign-in expired (${when}).`,
      "Claude's subscription login can only renew itself for so long; it has now lapsed, so I can't answer messages until you sign in again. Takes about 30 seconds from your phone:",
      ...signInStepsMarkdown(),
    ].join('\n');
  }
  return [
    `🔑 **Claude Code sign-in expires ${left}** (${when}).`,
    "Claude's subscription login can only renew itself for so long; after that every message fails until you sign in again. Renew it now and nothing is interrupted — about 30 seconds from your phone:",
    ...signInStepsMarkdown(),
  ].join('\n');
}

/** One check. Exported for tests and for an on-demand poke after sign-in. */
export async function checkLoginExpiry(now = Date.now()): Promise<ExpiryStage | null> {
  if (getEngineId() !== 'claude' || !usesHostLogin('claude')) return null;
  const cred = await readClaudeCredential(true);
  const deadline = cred?.loginExpiresAt;
  if (!deadline) return null;
  const stage = expiryStage(deadline, now);
  if (!stage) return null;
  if (!claimNotice(deadline, stage)) return stage;

  if (stage === 'expired') {
    saveAuthProbe('claude', {
      authed: false,
      ...getAuthConfig('claude'),
      error: `Sign-in expired on ${describeDeadline(deadline)}: the OAuth refresh token lapsed, so the CLI can no longer renew its session. Sign in again below.`,
    });
  }
  if (!getTelegramConfig().chatId) return stage;

  const text = noticeMarkdown(stage, deadline);
  const r = await sendTelegramRich(text);
  logMessage({
    direction: 'out',
    text: `[auth-watch] ${text}`,
    session_id: null,
    ok: r.ok,
    error: r.ok ? null : (r.error ?? null),
  });
  if (r.ok) {
    addPendingContext({
      source: 'auth-watch',
      kind: 'login expiry',
      text:
        stage === 'expired'
          ? `The host's Claude Code sign-in expired on ${describeDeadline(deadline)}; the user was told to sign in again from the dashboard.`
          : `The host's Claude Code sign-in expires ${describeDeadline(deadline)}; the user was reminded to sign in again from the dashboard before then.`,
    });
  } else {
    console.error(`[auth-watch] notice delivery failed: ${r.error}`);
  }
  return stage;
}

export function startAuthExpiryWatch(): void {
  const tick = () =>
    void checkLoginExpiry().catch((err) => console.error('[auth-watch] check failed:', err));
  setTimeout(tick, 20_000);
  setInterval(tick, CHECK_MS);
}
