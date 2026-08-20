/**
 * Drives Claude Code's subscription sign-in (`claude auth login`) from the
 * dashboard, so the operator never has to open a terminal.
 *
 * Unlike the old `setup-token` flow (which minted a token we stored in the DB
 * and injected per-run), `auth login` writes real credentials to the host
 * (~/.claude / keychain) — so plain `claude` works machine-wide afterwards,
 * not just relay-spawned runs.
 *
 * The login is a raw-mode TUI (Ink): it crashes on a plain pipe and needs a
 * real PTY (see pty-bridge.py). We:
 *   1. read its output and scrape the OAuth authorize URL,
 *   2. hand the URL to the UI (the user authorizes in their own browser; the
 *      CLI polls the OAuth server and usually finishes on its own),
 *   3. optionally write a pasted code back into the PTY (fallback path —
 *      the redirect page shows one),
 *   4. watch for the CLI's "Login successful." to mark completion.
 *
 * Only one login runs at a time.
 */
import { homedir } from 'node:os';
import { setOauthToken } from './engine.ts';
import { claudeAuthStatus } from './claude-runner.ts';

/**
 * Env for the interactive CLI. pm2 runs the relay with a stripped environment
 * (often no TERM, sometimes no HOME), and the raw-mode TUI silently exits 0 with
 * no output when TERM is missing on Linux — so backfill sane defaults.
 */
function loginEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: process.env.HOME || homedir(),
    TERM: process.env.TERM || 'xterm-256color',
  };
}

type Subproc = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

export type LoginState = 'awaiting' | 'done' | 'error';

type LoginSession = {
  proc: Subproc;
  buf: string;
  url: string | null;
  state: LoginState;
  error: string | null;
};

let session: LoginSession | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip ANSI/OSC escapes and stray control chars, keeping \n \r \t. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL/ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[=>]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** A human-readable tail of CLI output for error messages. */
function tidyTail(raw: string, max = 500): string {
  const clean = stripAnsi(raw)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return clean.slice(-max);
}

/**
 * Extract the authorize URL from PTY output. `auth login` prints it on one
 * line (the bridge sets a 1000-col window, so no wrapping), prefixed with
 * "If the browser didn't open, visit: ". Requiring the trailing newline
 * guarantees we never return a partially-flushed URL.
 */
function extractUrl(raw: string): string | null {
  const m = stripAnsi(raw).match(/(https?:\/\/\S*oauth\/authorize\S*)[ \t]*[\r\n]/i);
  if (!m || !/state=/.test(m[1])) return null;
  return m[1];
}

/** Accept a bare code, or extract it from a pasted callback URL. */
function normalizePastedCode(raw: string): string {
  const s = raw.trim();
  if (/[?&]code=/.test(s)) {
    try {
      const u = new URL(s);
      const code = u.searchParams.get('code') ?? '';
      const state = u.searchParams.get('state');
      // Claude's manual exchange expects `code#state`.
      if (code) return state ? `${code}#${state}` : code;
    } catch {
      // not a URL — fall through
    }
  }
  return s;
}

// Run the login inside a real PTY via our Python bridge (the server has no
// controlling tty of its own, and the raw-mode TUI requires one).
const BRIDGE = new URL('./pty-bridge.py', import.meta.url).pathname;
function ptyCommand(): string[] {
  return ['python3', BRIDGE, 'claude', 'auth', 'login'];
}

export function cancelClaudeLogin(): void {
  if (!session) return;
  try {
    session.proc.kill();
  } catch {
    // ignore
  }
  session = null;
}

/** True if Claude reports a logged-in subscription (cheap, no billed request). */
export async function isClaudeLoggedIn(): Promise<boolean> {
  const status = await claudeAuthStatus();
  return status?.loggedIn === true;
}

/**
 * Start `claude auth login` in a PTY and return the authorize URL to show the
 * user. Replaces any in-progress login.
 */
export async function startClaudeLogin(): Promise<{ url: string }> {
  cancelClaudeLogin();

  let proc: Subproc;
  try {
    proc = Bun.spawn(ptyCommand(), {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: loginEnv(),
    });
  } catch (err) {
    throw new Error(
      `Couldn't start the login process (is python3 installed?): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const s: LoginSession = {
    proc,
    buf: '',
    url: null,
    state: 'awaiting',
    error: null,
  };
  session = s;
  console.error(`[claude-login] started pid=${proc.pid} cmd=${ptyCommand().join(' ')}`);

  // Continuously drain stdout (so the PTY doesn't block) and watch for both the
  // authorize URL and completion. The CLI polls the OAuth server, so "Login
  // successful." usually appears on its own once the user authorizes — with a
  // pasted code (the fallback path) or without one.
  (async () => {
    try {
      const reader = proc.stdout.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        s.buf += dec.decode(value, { stream: true });
        if (!s.url) s.url = extractUrl(s.buf);
        if (s.state === 'awaiting') {
          const clean = stripAnsi(s.buf);
          if (/Login successful/i.test(clean)) {
            // Credentials now live on the host (~/.claude / keychain). Clear
            // any legacy setup-token from the DB so runs and auth probes stop
            // overriding the machine-wide login.
            setOauthToken('claude', '');
            s.state = 'done';
          } else if (
            /OAuth error:|Invalid code|expired|Press Enter to retry|Login failed/i.test(clean)
          ) {
            // The CLI rejected the code (wrong/truncated/expired). Surface it
            // and stop, rather than leaving the user staring at a spinner.
            const line = clean.match(/OAuth error:[^\n\r]*/i)?.[0];
            s.error = (line || 'Sign-in failed — the code may be wrong or expired.')
              .replace(/\s+/g, ' ')
              .trim();
            s.state = 'error';
            try {
              s.proc.kill();
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // process ended / killed
    }
    // The process has exited. If we never saw success, it's a failure.
    const exitCode = await proc.exited.catch(() => -1);
    if (s.state === 'awaiting') {
      s.state = 'error';
      const tail = tidyTail(s.buf, 600);
      s.error =
        tail || `Sign-in ended before completing (CLI exited code ${exitCode}, no output).`;
      console.error(
        `[claude-login] auth login exited code=${exitCode} bufLen=${s.buf.length} tail=${JSON.stringify(
          stripAnsi(s.buf).slice(-400)
        )}`
      );
    }
  })();
  // Drain stderr too.
  (async () => {
    try {
      s.buf += await new Response(proc.stderr).text();
    } catch {
      // ignore
    }
  })();

  // Wait up to 25s for the URL to appear (or the process to die early).
  const deadline = Date.now() + 25_000;
  let exitedEarly = false;
  proc.exited.then(() => {
    exitedEarly = true;
  });
  while (!s.url && Date.now() < deadline && !exitedEarly) {
    await sleep(200);
  }

  if (!s.url) {
    const tail = tidyTail(s.buf);
    cancelClaudeLogin();
    throw new Error(
      tail
        ? `Couldn't read a sign-in URL from the CLI. Output:\n${tail}`
        : 'Timed out waiting for a sign-in URL from the CLI.'
    );
  }
  return { url: s.url };
}

/**
 * Feed the code the user pasted into the waiting CLI (the fallback path when
 * the CLI's own polling doesn't complete). Completion is observed
 * asynchronously by the drain loop, so callers poll `claudeLoginStatus`.
 */
export async function submitClaudeLoginCode(
  raw: string
): Promise<{ ok: boolean; error?: string }> {
  const s = session;
  if (!s) return { ok: false, error: 'No sign-in is in progress — start again.' };
  if (s.state === 'done') return { ok: true };
  if (s.state === 'error') {
    return { ok: false, error: s.error || 'Sign-in already failed — start again.' };
  }

  const code = normalizePastedCode(raw);
  if (!code) return { ok: false, error: 'Paste the code from the sign-in page.' };

  try {
    // The CLI's paste prompt is a raw-mode Ink input. Send the code, then send
    // Enter (\r — NOT \n) as a SEPARATE write: if the \r rides in the same chunk
    // as the code, Ink treats it as pasted text and never submits.
    s.proc.stdin.write(code);
    await s.proc.stdin.flush();
    await sleep(250);
    s.proc.stdin.write('\r');
    await s.proc.stdin.flush();
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't send the code to the CLI: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return { ok: true };
}

/** Poll the in-progress sign-in. `done` means the host is now signed in. */
export function claudeLoginStatus(): { state: 'idle' | LoginState; error?: string } {
  if (!session) return { state: 'idle' };
  return { state: session.state, error: session.error ?? undefined };
}
