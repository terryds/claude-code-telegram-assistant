/**
 * Reads the *metadata* of the host's Claude subscription credential — expiry
 * timestamps only, never the tokens — so the relay can tell when the sign-in
 * is going to lapse instead of discovering it from a failed run.
 *
 * Claude Code keeps the credential in the macOS keychain (service
 * "Claude Code-credentials") or, elsewhere, in `<config dir>/.credentials.json`;
 * both hold a `claudeAiOauth` object with:
 *   - `expiresAt`             access token, renewed silently every ~8h
 *   - `refreshTokenExpiresAt` refresh token — a hard deadline. It is not
 *     extended by use, so once it passes the CLI cannot renew anything and
 *     every run fails with "OAuth session expired and could not be refreshed"
 *     until someone signs in again.
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { usesHostLogin } from './engine.ts';

export type ClaudeCredentialInfo = {
  /** Access-token expiry (ms epoch). Informational — the CLI refreshes it. */
  accessExpiresAt: number | null;
  /** Refresh-token expiry (ms epoch): when the sign-in itself dies. */
  loginExpiresAt: number | null;
  source: 'keychain' | 'file';
};

const CACHE_MS = 30_000;
let cache: { at: number; value: ClaudeCredentialInfo | null } | null = null;

/** Forget the cached read (call after a sign-in so the new deadline shows at once). */
export function invalidateCredentialCache(): void {
  cache = null;
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), '.claude');
}

function parse(raw: string, source: ClaudeCredentialInfo['source']): ClaudeCredentialInfo | null {
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
    const o = j?.claudeAiOauth;
    if (!o || typeof o !== 'object') return null;
    const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);
    return {
      accessExpiresAt: num(o.expiresAt),
      loginExpiresAt: num(o.refreshTokenExpiresAt),
      source,
    };
  } catch {
    return null;
  }
}

async function readKeychain(): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    // Never hang the dashboard on a locked keychain prompt.
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, 3_000);
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

async function readFile(): Promise<string | null> {
  try {
    const f = Bun.file(join(configDir(), '.credentials.json'));
    return (await f.exists()) ? await f.text() : null;
  } catch {
    return null;
  }
}

/** The host credential's expiry info, or null if there is none / it's unreadable. */
export async function readClaudeCredential(force = false): Promise<ClaudeCredentialInfo | null> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: ClaudeCredentialInfo | null = null;
  if (platform() === 'darwin') {
    const raw = await readKeychain();
    if (raw) value = parse(raw, 'keychain');
  }
  if (!value) {
    const raw = await readFile();
    if (raw) value = parse(raw, 'file');
  }
  cache = { at: Date.now(), value };
  return value;
}

/**
 * When the relay's runs depend on the host's subscription login, the ms-epoch
 * at which that login expires; null when unknown or when another auth method
 * (API key, legacy setup-token) is in use and the deadline doesn't apply.
 */
export async function hostLoginExpiresAt(): Promise<number | null> {
  if (!usesHostLogin('claude')) return null;
  const cred = await readClaudeCredential();
  return cred?.loginExpiresAt ?? null;
}

/** "Oct 17, 20:41 UTC" — unambiguous in a Telegram message read in any timezone. */
export function describeDeadline(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const time = d.toISOString().slice(11, 16);
  return `${date}, ${time} UTC`;
}
