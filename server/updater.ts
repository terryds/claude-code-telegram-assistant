// Self-update: check git for new commits and run bin/safe-update-relay from
// the dashboard or the /update Telegram command.
//
// The script is spawned fully detached (setsid + nohup) because it restarts
// this very process via pm2 mid-flight — a child tied to our lifetime would
// be killed halfway through. Outcome reporting flows through
// data/update-state.json, which the script writes and we read back after the
// restart.

import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getSetting, setSetting, logMessage } from './db.ts';
import { sendTelegram } from './telegram.ts';
import { getDashboardUrl } from './dashboard-url.ts';

const REPO_DIR = resolve(import.meta.dir, '..');
const SCRIPT = resolve(REPO_DIR, 'bin/safe-update-relay');
const STATE_FILE = resolve(REPO_DIR, 'data/update-state.json');

// A "running" state older than this is a crashed/killed updater, not a live one.
const RUNNING_STALE_MS = 10 * 60 * 1000;

export type UpdateState = {
  phase: 'running' | 'failed' | 'success';
  step?: string;
  detail?: string;
  old?: string;
  new?: string;
  ts: number;
};

export type CommitInfo = { sha: string; subject: string; date?: string };

/** Outcome of the most recent remote check (manual or automatic). */
export type UpdateCheckRecord = {
  behind: number;
  commits: CommitInfo[];
  /** Upstream head sha — identifies "this" update for once-only notices. */
  head: string | null;
  checked_at: number;
  /** Set when the check itself failed (fetch error); behind/commits are stale. */
  error?: string;
};

let lastCheck: UpdateCheckRecord | null = null;

export function getLastUpdateCheck(): UpdateCheckRecord | null {
  return lastCheck;
}

function git(args: string[]): string | null {
  const r = Bun.spawnSync(['git', ...args], { cwd: REPO_DIR });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().trim();
}

export function readUpdateState(): UpdateState | null {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const s = JSON.parse(raw) as UpdateState;
    return typeof s.ts === 'number' && typeof s.phase === 'string' ? s : null;
  } catch {
    return null;
  }
}

function writeUpdateState(state: UpdateState): void {
  try {
    mkdirSync(resolve(REPO_DIR, 'data'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // best-effort — the script will overwrite it anyway
  }
}

export function isUpdateRunning(): boolean {
  const s = readUpdateState();
  return s?.phase === 'running' && Date.now() - s.ts < RUNNING_STALE_MS;
}

export function currentVersion(): CommitInfo | null {
  const line = git(['log', '-1', '--format=%h\t%s\t%cI']);
  if (!line) return null;
  const [sha, subject, date] = line.split('\t');
  return { sha, subject, date };
}

/** Is this process managed by pm2? (pm2 injects pm_id into the env.) */
export function isPm2Managed(): boolean {
  return process.env.pm_id !== undefined;
}

export function updateInfo(): {
  current: CommitInfo | null;
  managed: boolean;
  running: boolean;
  state: UpdateState | null;
  check: UpdateCheckRecord | null;
} {
  return {
    current: currentVersion(),
    managed: isPm2Managed(),
    running: isUpdateRunning(),
    state: readUpdateState(),
    check: lastCheck,
  };
}

/**
 * git fetch + how far behind upstream we are. A network call, so it's async
 * (the auto-check runs inside the relay and must not block message handling).
 * The outcome is cached for the dashboard either way.
 */
export async function checkForUpdates(): Promise<
  | { ok: true; behind: number; commits: CommitInfo[]; head: string | null }
  | { ok: false; error: string }
> {
  const fail = (error: string) => {
    lastCheck = {
      behind: lastCheck?.behind ?? 0,
      commits: lastCheck?.commits ?? [],
      head: lastCheck?.head ?? null,
      checked_at: Date.now(),
      error,
    };
    return { ok: false as const, error };
  };
  const fetch = Bun.spawn(['git', 'fetch', '--quiet'], {
    cwd: REPO_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const timer = setTimeout(() => {
    try {
      fetch.kill();
    } catch {
      // ignore
    }
  }, 60_000);
  const [, fetchErr, fetchCode] = await Promise.all([
    new Response(fetch.stdout).text(),
    new Response(fetch.stderr).text(),
    fetch.exited,
  ]);
  clearTimeout(timer);
  if (fetchCode !== 0) return fail(`git fetch failed: ${fetchErr.trim() || 'unknown error'}`);

  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || 'origin/main';
  const behindRaw = git(['rev-list', '--count', `HEAD..${upstream}`]);
  if (behindRaw === null) return fail(`Cannot compare against ${upstream}.`);
  const behind = Number(behindRaw) || 0;
  const head = git(['rev-parse', '--short', upstream]);
  const commits: CommitInfo[] = [];
  if (behind > 0) {
    const log = git(['log', `HEAD..${upstream}`, '--format=%h\t%s', '-n', '10']) || '';
    for (const line of log.split('\n').filter(Boolean)) {
      const [sha, subject] = line.split('\t');
      commits.push({ sha, subject });
    }
  }
  lastCheck = { behind, commits, head, checked_at: Date.now() };
  return { ok: true, behind, commits, head };
}

// ── Automatic check ─────────────────────────────────────────────────
//
// The dashboard used to know about new versions only when someone clicked
// "Check for updates". Now the relay checks on its own — shortly after boot
// and then periodically — caches the result for the dashboard, and tells the
// user over Telegram once per new upstream version (they can reply /update).

const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;
const NOTIFIED_HEAD_KEY = 'update_notified_head';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function autoCheckForUpdates(): Promise<void> {
  if (isUpdateRunning()) return; // the updater is mid-flight; the restart will re-check
  const r = await checkForUpdates();
  if (!r.ok) {
    console.warn(`[updater] auto-check failed: ${r.error}`);
    return;
  }
  if (r.behind === 0 || !r.head) return;
  if (getSetting(NOTIFIED_HEAD_KEY) === r.head) return; // already told them about this one
  setSetting(NOTIFIED_HEAD_KEY, r.head);

  const url = getDashboardUrl();
  const list = r.commits
    .slice(0, 5)
    .map((c) => `• <code>${escapeHtml(c.sha)}</code> ${escapeHtml(c.subject)}`)
    .join('\n');
  const more = r.behind > 5 ? `\n…and ${r.behind - 5} more` : '';
  const text = [
    `🆕 <b>Relay update available</b> — ${r.behind} new commit${r.behind === 1 ? '' : 's'}:`,
    list + more,
    '',
    `Send /update to install (pull → build → restart)${url ? `, or use the dashboard:\n${escapeHtml(url)}/#updates` : '.'}`,
  ].join('\n');
  const sent = await sendTelegram(text);
  logMessage({
    direction: 'out',
    text: `[updater] ${text}`,
    session_id: null,
    ok: sent.ok,
    error: sent.ok ? null : (sent.error ?? null),
  });
  if (!sent.ok) console.error(`[updater] update notice failed: ${sent.error}`);
}

export function startUpdateAutoCheck(): void {
  const tick = () =>
    void autoCheckForUpdates().catch((err) => console.error('[updater] auto-check crashed:', err));
  setTimeout(tick, 45_000);
  setInterval(tick, AUTO_CHECK_MS);
}

/** Kick off bin/safe-update-relay, detached so it survives the pm2 restart. */
export function startUpdate(): { ok: true } | { ok: false; error: string } {
  if (isUpdateRunning()) return { ok: false, error: 'An update is already in progress.' };
  if (!existsSync(SCRIPT)) return { ok: false, error: 'bin/safe-update-relay not found.' };
  if (!isPm2Managed()) {
    return {
      ok: false,
      error: 'The relay is not running under pm2 — update manually (git pull && bun run build).',
    };
  }
  // Claim the lock immediately so a double-click can't race two updaters
  // (the script overwrites this with its own progress).
  writeUpdateState({ phase: 'running', step: 'starting', ts: Date.now() });
  // 2s delay gives our HTTP response time to reach the client before the
  // restart tears the server down.
  const r = Bun.spawnSync([
    'bash',
    '-c',
    `setsid nohup "${SCRIPT}" 2 >/dev/null 2>&1 < /dev/null &`,
  ]);
  if (r.exitCode !== 0) {
    writeUpdateState({ phase: 'failed', step: 'spawn', detail: r.stderr.toString().trim(), ts: Date.now() });
    return { ok: false, error: 'Failed to launch the updater.' };
  }
  return { ok: true };
}
