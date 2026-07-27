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
} {
  return {
    current: currentVersion(),
    managed: isPm2Managed(),
    running: isUpdateRunning(),
    state: readUpdateState(),
  };
}

/** git fetch + how far behind upstream we are. Network call — user-triggered. */
export function checkForUpdates():
  | { ok: true; behind: number; commits: CommitInfo[] }
  | { ok: false; error: string } {
  const fetch = Bun.spawnSync(['git', 'fetch', '--quiet'], { cwd: REPO_DIR });
  if (fetch.exitCode !== 0) {
    return { ok: false, error: `git fetch failed: ${fetch.stderr.toString().trim() || 'unknown error'}` };
  }
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || 'origin/main';
  const behindRaw = git(['rev-list', '--count', `HEAD..${upstream}`]);
  if (behindRaw === null) return { ok: false, error: `Cannot compare against ${upstream}.` };
  const behind = Number(behindRaw) || 0;
  const commits: CommitInfo[] = [];
  if (behind > 0) {
    const log = git(['log', `HEAD..${upstream}`, '--format=%h\t%s', '-n', '10']) || '';
    for (const line of log.split('\n').filter(Boolean)) {
      const [sha, subject] = line.split('\t');
      commits.push({ sha, subject });
    }
  }
  return { ok: true, behind, commits };
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
