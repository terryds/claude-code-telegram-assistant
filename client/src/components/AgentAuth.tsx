import { useEffect, useState } from 'react';
import { api, type AuthConfig, type AuthMethod, type EngineAuth, type EngineId } from '../api';

const DOCS: Record<
  EngineId,
  { label: string; loginCmd: string; keyEnv: string; keyHelp: string; href: string }
> = {
  claude: {
    label: 'Claude Code',
    loginCmd: 'claude auth login',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyHelp: 'Anthropic API key (starts with sk-ant-…)',
    href: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
};

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Oct 17" in the viewer's own timezone. */
export function describeDeadline(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "in 12 days" / "tomorrow" / "today" / "expired". */
export function deadlineLabel(ts: number, now = Date.now()): string {
  const left = ts - now;
  if (left <= 0) return 'expired';
  const days = Math.floor(left / DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export function expiresSoon(ts: number | null | undefined, now = Date.now()): boolean {
  return ts != null && ts - now <= 3 * DAY_MS;
}

/**
 * One-line auth health for the top of the dashboard. Reads the cached status
 * (which the relay keeps truthful from real run outcomes) every 30s — no probe,
 * no billed request. Quiet when healthy; a banner with a one-tap fix when not.
 */
export function AuthStatusStrip({ engine, label }: { engine: EngineId; label: string }) {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      api
        .authConfig(engine)
        .then((c) => {
          if (!stopped) setCfg(c);
        })
        .catch(() => {});
    load();
    const id = window.setInterval(load, 30_000);
    window.addEventListener('focus', load);
    return () => {
      stopped = true;
      window.clearInterval(id);
      window.removeEventListener('focus', load);
    };
  }, [engine]);

  if (!cfg) return null;
  const last = cfg.last ?? null;
  const exp = cfg.login_expires_at ?? null;
  const via = cfg.method === 'apikey' ? 'API key' : 'subscription login';
  const fix = (text: string) => (
    <a
      href="#auth"
      className="shrink-0 px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm font-medium"
    >
      {text}
    </a>
  );

  if (last && !last.authed) {
    return (
      <div className="rounded-lg border border-red-900/60 bg-red-950/40 text-red-100 p-4 flex items-start justify-between gap-4">
        <div className="text-sm space-y-1">
          <div className="font-medium">
            ⛔ {label} is signed out — Telegram messages fail until you sign in again.
          </div>
          {last.error && <div className="text-red-200/70 text-xs">{last.error}</div>}
          <div className="text-red-200/50 text-xs">Noticed {timeAgo(last.checked_at)}.</div>
        </div>
        {fix('Sign in again ↓')}
      </div>
    );
  }

  if (exp && expiresSoon(exp)) {
    return (
      <div className="rounded-lg border border-amber-900/60 bg-amber-950/40 text-amber-100 p-4 flex items-start justify-between gap-4">
        <div className="text-sm space-y-1">
          <div className="font-medium">
            🔑 {label} sign-in expires {deadlineLabel(exp)} ({describeDeadline(exp)}).
          </div>
          <div className="text-amber-200/70 text-xs">
            Claude's login can't renew itself past that date. Sign in again now and nothing is interrupted.
          </div>
        </div>
        {fix('Sign in again ↓')}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500">
      <span
        className={['w-1.5 h-1.5 rounded-full', last ? 'bg-emerald-400' : 'bg-zinc-600'].join(' ')}
      />
      {last ? (
        <span>
          {label} signed in via {via} · confirmed {timeAgo(last.checked_at)}
          {exp ? ` · valid until ${describeDeadline(exp)}` : ''}
        </span>
      ) : (
        <span>
          {label} auth not checked yet ·{' '}
          <a href="#auth" className="underline hover:text-zinc-300">
            check
          </a>
        </span>
      )}
    </div>
  );
}

type Props = {
  engine: EngineId;
  /** Run a live probe on mount / engine change. Onboarding wants this; the
   *  dashboard defaults to off (probing costs a request) and probes on demand. */
  autoProbe?: boolean;
  /** Notified whenever a probe resolves, so a parent can gate on auth. */
  onAuthed?: (authed: boolean) => void;
};

export function AgentAuth({ engine, autoProbe = true, onAuthed }: Props) {
  const docs = DOCS[engine];

  const [method, setMethod] = useState<AuthMethod>('subscription');
  const [hasKey, setHasKey] = useState(false);
  const [auth, setAuth] = useState<EngineAuth | null>(null);
  const [checking, setChecking] = useState(false);
  const [probed, setProbed] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [loginExpiresAt, setLoginExpiresAt] = useState<number | null>(null);

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Interactive Claude subscription sign-in (no terminal).
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState('');
  const [loginBusy, setLoginBusy] = useState<'start' | 'submit' | null>(null);
  const [loginErr, setLoginErr] = useState<string | null>(null);

  const probe = async () => {
    setChecking(true);
    setErr(null);
    try {
      const r = await api.authCheck(engine);
      setAuth(r);
      setMethod(r.method);
      setHasKey(r.hasKey);
      setProbed(true);
      setCheckedAt(r.checked_at ?? Date.now());
      setLoginExpiresAt(r.login_expires_at ?? null);
      onAuthed?.(r.authed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const loadConfig = async () => {
    try {
      const c = await api.authConfig(engine);
      setMethod(c.method);
      setHasKey(c.hasKey);
      setLoginExpiresAt(c.login_expires_at ?? null);
      // The server caches the last probe's outcome — show it instantly instead
      // of demanding a click. Only probe live when nothing was ever cached.
      if (c.last) {
        setAuth({ authed: c.last.authed, method: c.last.method, hasKey: c.hasKey, error: c.last.error });
        setProbed(true);
        setCheckedAt(c.last.checked_at);
        onAuthed?.(c.last.authed);
      } else {
        await probe();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    // Reset per-engine state, then either probe (onboarding) or show the
    // cached result (dashboard) so we don't spend a request on every page load.
    setAuth(null);
    setProbed(false);
    setCheckedAt(null);
    setKey('');
    resetLogin();
    onAuthed?.(false);
    if (autoProbe) probe();
    else loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // On the dashboard, the cached status moves on its own: every relay run
  // writes its outcome back (a failed auth flips it to signed-out, a completed
  // turn confirms it). Pick those changes up without a click or a probe.
  useEffect(() => {
    if (autoProbe) return;
    let stopped = false;
    const tick = async () => {
      try {
        const c = await api.authConfig(engine);
        if (stopped || !c.last) return;
        setLoginExpiresAt(c.login_expires_at ?? null);
        setAuth((prev) =>
          prev && prev.authed === c.last!.authed && prev.error === c.last!.error
            ? prev
            : { authed: c.last!.authed, method: c.last!.method, hasKey: c.hasKey, error: c.last!.error }
        );
        setProbed(true);
        setCheckedAt(c.last.checked_at);
      } catch {
        // transient — try again next tick
      }
    };
    const id = window.setInterval(tick, 30_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [engine, autoProbe]);

  const resetLogin = () => {
    setLoginUrl(null);
    setLoginCode('');
    setLoginErr(null);
    api.claudeLoginCancel().catch(() => {});
  };

  const startLogin = async () => {
    setLoginBusy('start');
    setLoginErr(null);
    try {
      const r = await api.claudeLoginStart();
      setLoginUrl(r.url); // starts the status poll (effect below)
    } catch (e) {
      setLoginErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(null);
    }
  };

  const submitLogin = async () => {
    setLoginBusy('submit');
    setLoginErr(null);
    try {
      // Feed the code; the poll detects completion and finishes the flow.
      await api.claudeLoginCode(loginCode.trim());
    } catch (e) {
      setLoginErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(null);
    }
  };

  // While a sign-in is in progress, poll for completion. `claude auth login`
  // polls the OAuth server itself, so it finishes on its own once the user
  // authorizes (pasting the code is only a fallback) — surfaces as 'done'.
  useEffect(() => {
    if (!loginUrl) return;
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const s = await api.claudeLoginStatus();
        if (stopped) return;
        if (s.state === 'done') {
          setLoginUrl(null);
          setLoginCode('');
          await probe();
          return;
        }
        if (s.state === 'error') {
          setLoginErr(s.error || 'Sign-in failed — try again.');
          setLoginUrl(null);
          return;
        }
      } catch {
        // keep polling
      }
      if (!stopped) timer = window.setTimeout(tick, 1500);
    };
    timer = window.setTimeout(tick, 1500);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginUrl]);

  const chooseMethod = async (m: AuthMethod) => {
    if (m === method) return;
    setMethod(m);
    setErr(null);
    try {
      await api.setAuthConfig(engine, { method: m });
      await probe();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const saveKey = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.setAuthConfig(engine, { method: 'apikey', apiKey: key.trim() });
      setKey('');
      await probe();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const authed = auth?.authed === true;

  return (
    <div className="space-y-4">
      {/* Status line */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          {checking ? (
            <span className="text-zinc-400">Checking authentication…</span>
          ) : authed ? (
            <span className="text-emerald-400">
              Authenticated via {method === 'apikey' ? 'API key' : 'subscription login'}.
              {checkedAt && (
                <span className="text-zinc-500"> Checked {timeAgo(checkedAt)}.</span>
              )}
            </span>
          ) : probed ? (
            <span className="text-amber-400">
              Not authenticated.
              {checkedAt && (
                <span className="text-zinc-500"> Checked {timeAgo(checkedAt)}.</span>
              )}
            </span>
          ) : (
            <span className="text-zinc-400">
              Auth not checked yet ({method === 'apikey' ? 'API key' : 'subscription login'}
              {method === 'apikey' && !hasKey ? ', no key saved' : ''}).
            </span>
          )}
        </div>
        <button
          onClick={probe}
          disabled={checking}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded text-sm shrink-0"
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {authed && method === 'subscription' && loginExpiresAt && (
        <p className={['text-xs', expiresSoon(loginExpiresAt) ? 'text-amber-300' : 'text-zinc-500'].join(' ')}>
          Sign-in valid until {describeDeadline(loginExpiresAt)} ({deadlineLabel(loginExpiresAt)}).
          Claude's login can't renew itself past that date — tap <strong>Sign in again</strong> before
          then. You'll get a Telegram reminder 3 days ahead, and the relay marks itself signed out
          the moment a run fails to authenticate.
        </p>
      )}

      {/* Method toggle */}
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1.5">
          Auth method
        </div>
        <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden text-sm font-medium">
          {(['subscription', 'apikey'] as AuthMethod[]).map((m) => (
            <button
              key={m}
              onClick={() => chooseMethod(m)}
              disabled={checking || saving}
              className={[
                'px-3 py-1.5 transition-colors disabled:opacity-50',
                method === m
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800',
              ].join(' ')}
            >
              {m === 'subscription' ? 'Subscription' : 'API key'}
            </button>
          ))}
        </div>
      </div>

      {/* Method-specific guidance */}
      {method === 'subscription' ? (
        <div className="text-sm space-y-3">
          {!authed && (
            <p className="text-zinc-400">
              Sign in with your Claude subscription — no terminal needed.
            </p>
          )}
          {!loginUrl ? (
            <button
              onClick={startLogin}
              disabled={loginBusy === 'start' || checking}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
            >
              {loginBusy === 'start'
                ? 'Starting…'
                : authed
                  ? 'Sign in again'
                  : 'Sign in with Claude'}
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-zinc-300">
                Open the sign-in page and <strong>authorize</strong> — this
                finishes on its own, even from your phone:
              </p>
              <div className="flex gap-2">
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-medium"
                >
                  Open sign-in page ↗
                </a>
                <button
                  onClick={() => navigator.clipboard?.writeText(loginUrl)}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs"
                >
                  Copy link
                </button>
              </div>
              <div className="inline-flex items-center gap-2 text-zinc-400 text-xs">
                <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                Waiting for you to authorize…
              </div>
              <div className="border-t border-zinc-800 pt-3 space-y-1.5">
                <p className="text-zinc-400 text-xs">
                  Authorized but stuck on “waiting”? Paste the code the page
                  shows you — or the full callback URL:
                </p>
                <div className="flex gap-2">
                  <input
                    autoComplete="off"
                    className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                    placeholder="paste code here…"
                    value={loginCode}
                    onChange={(e) => setLoginCode(e.target.value)}
                    disabled={loginBusy === 'submit'}
                  />
                  <button
                    onClick={submitLogin}
                    disabled={loginBusy === 'submit' || !loginCode.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
                  >
                    {loginBusy === 'submit' ? 'Sending…' : 'Submit code'}
                  </button>
                </div>
              </div>
              <button
                onClick={resetLogin}
                className="text-zinc-500 hover:text-zinc-300 text-xs underline"
              >
                Cancel
              </button>
            </div>
          )}
          {loginErr && (
            <pre className="bg-zinc-900 text-red-300/90 text-xs p-3 rounded overflow-auto whitespace-pre-wrap">
              {loginErr}
            </pre>
          )}
          <p className="text-xs text-zinc-600">
            Prefer the terminal? Run{' '}
            <code className="text-zinc-400">claude auth login</code> on the host
            instead. Either way the whole machine is signed in — plain{' '}
            <code className="text-zinc-400">claude</code> works outside the relay
            too.
          </p>
        </div>
      ) : (
        <div className="text-sm space-y-2">
          <p className="text-zinc-400">
            The key is stored on this server and passed to {docs.label} as{' '}
            <code className="text-zinc-200">{docs.keyEnv}</code> on every run.
            Billing goes against this key (pay-per-token), not a subscription.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
              placeholder={hasKey ? '•••••••••• (saved — paste to replace)' : docs.keyHelp}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={saving}
            />
            <button
              onClick={saveKey}
              disabled={saving || !key.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
            >
              {saving ? 'Saving…' : hasKey ? 'Replace' : 'Save key'}
            </button>
          </div>
          {hasKey && (
            <button
              onClick={() => api.setAuthConfig(engine, { apiKey: '' }).then(() => setHasKey(false))}
              className="text-zinc-500 hover:text-zinc-300 text-xs underline"
            >
              Remove saved key
            </button>
          )}
        </div>
      )}

      {/* Probe error detail */}
      {!authed && probed && auth?.error && (
        <pre className="bg-zinc-900 text-amber-300/80 text-xs p-3 rounded overflow-auto whitespace-pre-wrap">
          {auth.error}
        </pre>
      )}
      {err && <p className="text-red-400 text-sm">{err}</p>}

      <p className="text-xs text-zinc-600">
        Need the CLI or an account?{' '}
        <a className="underline hover:text-zinc-400" href={docs.href} target="_blank" rel="noreferrer">
          {docs.label} docs
        </a>
        .
      </p>
    </div>
  );
}
