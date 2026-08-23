import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import QRCode from 'qrcode';
import {
  api,
  type AgentCheck,
  type EngineId,
  type Status,
  type BotInfo,
  type QrPairing,
} from '../api';
import { AgentAuth } from '../components/AgentAuth';

type Props = { status: Status; onChange: () => void };

const INSTALL_DOCS: Record<EngineId, { label: string; cli: string; href: string }> = {
  claude: {
    label: 'Claude Code',
    cli: 'claude',
    href: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
  codex: {
    label: 'Codex',
    cli: 'codex',
    href: 'https://developers.openai.com/codex/cli',
  },
};

export function Onboarding({ status, onChange }: Props) {
  const [, setLocation] = useLocation();

  const [engine, setEngine] = useState<EngineId>(status.engine);
  const [agentCheck, setAgentCheck] = useState<AgentCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [authed, setAuthed] = useState(false);

  const [token, setToken] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [bot, setBot] = useState<BotInfo | null>(status.bot);

  const [capturing, setCapturing] = useState(false);
  const [capturedId, setCapturedId] = useState<string | null>(status.chat_id);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // BotFather is the default: the managed-bots QR flow isn't supported yet by
  // every Telegram client (notably some Android builds).
  const [method, setMethod] = useState<'qr' | 'manual'>('manual');
  const [qr, setQr] = useState<QrPairing | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrStarting, setQrStarting] = useState(false);
  const [qrWaiting, setQrWaiting] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrNow, setQrNow] = useState(() => Date.now());
  const qrPollRef = useRef<number | null>(null);

  // Decide which step to land on. Step 1 isn't done until the CLI is both
  // installed and authenticated.
  const agentOk = agentCheck?.installed === true;
  const step =
    !agentOk || !authed
      ? 1
      : !status.bot_token_set || !bot
        ? 2
        : !capturedId
          ? 3
          : 4;

  const runAgentCheck = async (id: EngineId) => {
    setChecking(true);
    try {
      const r = await api.agentCheck(id);
      setAgentCheck(r);
    } catch (e) {
      setAgentCheck({
        installed: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setChecking(false);
    }
  };

  const selectEngine = async (id: EngineId) => {
    if (id === engine && agentCheck) return;
    setEngine(id);
    setAgentCheck(null);
    setAuthed(false);
    try {
      await api.setEngine(id);
      onChange();
    } catch {
      // check below will still surface install state
    }
    runAgentCheck(id);
  };

  useEffect(() => {
    runAgentCheck(status.engine);
  }, []);

  const saveToken = async () => {
    setTokenError(null);
    setSavingToken(true);
    try {
      const r = await api.saveToken(token.trim());
      setBot(r.bot);
      setCapturedId(null);
      onChange();
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingToken(false);
    }
  };

  const resetQr = (message: string | null = null) => {
    setQrWaiting(false);
    setQr(null);
    setQrDataUrl(null);
    if (message !== null) setQrError(message);
  };

  const startQr = async () => {
    setQrError(null);
    setQrStarting(true);
    try {
      const p = await api.qrStart();
      const dataUrl = await QRCode.toDataURL(p.qr_payload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 224,
      });
      setQr(p);
      setQrDataUrl(dataUrl);
      setQrNow(Date.now());
      setQrWaiting(true);
    } catch (e) {
      setQrError(e instanceof Error ? e.message : String(e));
    } finally {
      setQrStarting(false);
    }
  };

  const cancelQr = () => {
    if (qr) api.qrCancel(qr.pairing_id).catch(() => {});
    resetQr();
  };

  // Poll the pairing until Telegram hands over the new bot. Network hiccups
  // are transient (keep polling); expired/claimed/error are terminal.
  useEffect(() => {
    if (!qrWaiting || !qr) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await api.qrPoll(qr.pairing_id);
        if (stopped) return;
        if (r.status === 'ready') {
          setBot(r.bot);
          if (r.chat_id) setCapturedId(r.chat_id);
          resetQr();
          onChange();
          return;
        }
        if (r.status !== 'waiting') {
          resetQr(
            r.status === 'error'
              ? r.error
              : 'The QR code expired — generate a new one to try again.'
          );
          return;
        }
      } catch {
        // transient — keep polling
      }
      if (!stopped) qrPollRef.current = window.setTimeout(tick, 2000);
    };
    qrPollRef.current = window.setTimeout(tick, 1200);
    return () => {
      stopped = true;
      if (qrPollRef.current) window.clearTimeout(qrPollRef.current);
    };
  }, [qrWaiting, qr?.pairing_id]);

  // Drive the expiry countdown, and expire client-side even if polling stalls.
  useEffect(() => {
    if (!qrWaiting) return;
    const t = window.setInterval(() => setQrNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [qrWaiting]);

  const qrRemaining = qr
    ? Math.max(0, Math.floor((Date.parse(qr.expires_at) - qrNow) / 1000))
    : 0;

  useEffect(() => {
    if (qrWaiting && qr && qrRemaining <= 0) {
      resetQr('The QR code expired — generate a new one to try again.');
    }
  }, [qrWaiting, qrRemaining]);

  const startCapture = async () => {
    setCaptureError(null);
    try {
      await api.startCapture();
      setCapturing(true);
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancelCapture = async () => {
    try {
      await api.cancelCapture();
    } catch {
      // ignore
    }
    setCapturing(false);
  };

  useEffect(() => {
    if (!capturing) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await api.captured();
        if (r.chat_id) {
          setCapturedId(r.chat_id);
          setCapturing(false);
          onChange();
          return;
        }
      } catch {
        // keep polling
      }
      if (!stopped) {
        pollRef.current = window.setTimeout(tick, 1500);
      }
    };
    tick();
    return () => {
      stopped = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [capturing]);

  const finish = async () => {
    try {
      await api.setRelay(true);
    } catch {
      // dashboard will surface relay state
    }
    onChange();
    setLocation('/');
  };

  return (
    <div className="min-h-full max-w-2xl mx-auto px-6 py-12">
      <header className="mb-10">
        <h1 className="text-2xl font-semibold">Welcome to claude-code-telegram-assistant</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Relay messages from a Telegram bot to your coding agent (Claude Code or
          Codex) running on this machine.
        </p>
      </header>

      <ol className="space-y-6">
        <StepCard
          n={1}
          title="Choose & authenticate your coding agent"
          active={step === 1}
          done={agentOk && authed}
        >
          <p className="text-zinc-400 text-sm mb-3">
            Pick which agent the relay drives. You can switch later from the
            dashboard or with the <code>/engine</code> command in Telegram.
          </p>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {status.engines.map((e) => (
              <button
                key={e.id}
                onClick={() => selectEngine(e.id)}
                className={[
                  'px-3 py-2 rounded border text-sm font-medium transition-colors',
                  engine === e.id
                    ? 'border-blue-600 bg-blue-950/40 text-zinc-100'
                    : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:bg-zinc-800',
                ].join(' ')}
              >
                {e.label}
              </button>
            ))}
          </div>

          {checking ? (
            <p className="text-zinc-400 text-sm">Checking…</p>
          ) : agentOk ? (
            <div className="text-sm space-y-4">
              <div className="space-y-1">
                <p className="text-emerald-400">Found {INSTALL_DOCS[engine].label}.</p>
                {agentCheck?.version && (
                  <p className="text-zinc-400">
                    Version: <code className="text-zinc-200">{agentCheck.version}</code>
                  </p>
                )}
                {agentCheck?.path && (
                  <p className="text-zinc-400">
                    Path: <code className="text-zinc-200">{agentCheck.path}</code>
                  </p>
                )}
              </div>
              <div className="border-t border-zinc-800 pt-4">
                <AgentAuth engine={engine} onAuthed={setAuthed} />
              </div>
            </div>
          ) : (
            <div className="text-sm space-y-3">
              <p className="text-red-400">
                The <code>{INSTALL_DOCS[engine].cli}</code> CLI was not found on PATH.
              </p>
              {agentCheck?.error && (
                <pre className="bg-zinc-900 text-zinc-400 text-xs p-3 rounded overflow-auto whitespace-pre-wrap">
                  {agentCheck.error}
                </pre>
              )}
              <p className="text-zinc-400">
                Install it from{' '}
                <a
                  className="underline text-zinc-200"
                  href={INSTALL_DOCS[engine].href}
                  target="_blank"
                  rel="noreferrer"
                >
                  the {INSTALL_DOCS[engine].label} docs
                </a>
                {engine === 'codex' && (
                  <>
                    {' '}and sign in with <code>codex login</code>
                  </>
                )}
                , then re-check.
              </p>
              <button
                onClick={() => runAgentCheck(engine)}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-sm"
              >
                Re-check
              </button>
            </div>
          )}
        </StepCard>

        <StepCard
          n={2}
          title="Connect your Telegram bot"
          active={step === 2}
          done={Boolean(bot)}
          disabled={step < 2}
        >
          <div className="grid grid-cols-2 gap-2 mb-4">
            <button
              onClick={() => {
                if (qrWaiting) cancelQr();
                setMethod('manual');
              }}
              disabled={step < 2}
              className={[
                'px-3 py-2 rounded border text-sm font-medium transition-colors',
                method === 'manual'
                  ? 'border-blue-600 bg-blue-950/40 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:bg-zinc-800',
              ].join(' ')}
            >
              Paste a BotFather token{' '}
              <span className="text-[10px] uppercase tracking-wide text-blue-300 ml-1">
                recommended
              </span>
            </button>
            <button
              onClick={() => setMethod('qr')}
              disabled={step < 2}
              className={[
                'px-3 py-2 rounded border text-sm font-medium transition-colors',
                method === 'qr'
                  ? 'border-blue-600 bg-blue-950/40 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-900/40 text-zinc-300 hover:bg-zinc-800',
              ].join(' ')}
            >
              Scan QR code
            </button>
          </div>

          {method === 'qr' ? (
            qrWaiting && qr && qrDataUrl ? (
              <div className="text-sm space-y-3">
                <div className="flex gap-4 items-start">
                  <img
                    src={qrDataUrl}
                    alt="Telegram setup QR code"
                    className="w-56 h-56 rounded bg-white p-2 shrink-0"
                  />
                  <div className="space-y-3 pt-1">
                    <p className="text-zinc-300">
                      Scan with your phone's camera or Telegram app, then confirm{' '}
                      <span className="font-mono text-zinc-100">
                        @{qr.suggested_username}
                      </span>{' '}
                      — Telegram creates the bot for you, no BotFather needed.
                    </p>
                    <p className="text-zinc-400">
                      On this device already?{' '}
                      <a
                        className="underline text-zinc-200"
                        href={qr.deep_link}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Telegram
                      </a>
                    </p>
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center gap-2 text-zinc-400">
                        <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                        Waiting for the scan… expires in{' '}
                        {Math.floor(qrRemaining / 60)}:
                        {String(qrRemaining % 60).padStart(2, '0')}
                      </span>
                      <button
                        onClick={cancelQr}
                        className="text-zinc-400 hover:text-zinc-200 underline"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-sm space-y-3">
                <p className="text-zinc-400">
                  Scan a QR code and Telegram creates a bot for you automatically
                  — it also links this chat, so you're done in one step. Note:
                  not all Telegram apps support this yet (some Android builds
                  don't); if the scan does nothing, use the BotFather method.
                </p>
                <button
                  onClick={startQr}
                  disabled={step < 2 || qrStarting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
                >
                  {qrStarting ? 'Generating…' : 'Generate QR code'}
                </button>
              </div>
            )
          ) : (
            <div>
              <ol className="text-zinc-400 text-sm mb-4 space-y-1.5 list-decimal list-inside">
                <li>
                  Open{' '}
                  <a
                    className="underline text-zinc-200"
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                  >
                    @BotFather
                  </a>{' '}
                  in Telegram and send{' '}
                  <code className="text-zinc-200 bg-zinc-900 px-1 rounded">/newbot</code>
                </li>
                <li>
                  Pick a display name — e.g.{' '}
                  <span className="text-zinc-300">My Personal Assistant</span>
                </li>
                <li>
                  Pick a username ending in <span className="text-zinc-300">bot</span> —
                  e.g.{' '}
                  <code className="text-zinc-200 bg-zinc-900 px-1 rounded">
                    my_personal_assistant_bot
                  </code>
                </li>
                <li>
                  Copy the token BotFather replies with (looks like{' '}
                  <code className="text-zinc-300">123456789:ABC…</code>) and paste it
                  below
                </li>
              </ol>
              <div className="flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                  placeholder="123456789:ABCdefGhIJK..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={step < 2 || savingToken}
                />
                <button
                  onClick={saveToken}
                  disabled={step < 2 || !token.trim() || savingToken}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
                >
                  {savingToken ? 'Saving…' : 'Save'}
                </button>
              </div>
              {tokenError && (
                <p className="text-red-400 text-sm mt-2">{tokenError}</p>
              )}
            </div>
          )}

          {qrError && method === 'qr' && (
            <p className="text-red-400 text-sm mt-3">{qrError}</p>
          )}
          {bot && (
            <p className="text-emerald-400 text-sm mt-3">
              Connected to <span className="font-mono">@{bot.username}</span>
            </p>
          )}
        </StepCard>

        <StepCard
          n={3}
          title="Send a message to your bot"
          active={step === 3}
          done={Boolean(capturedId)}
          disabled={step < 3}
        >
          {capturedId ? (
            <div className="text-sm space-y-1">
              <p className="text-emerald-400">Chat linked.</p>
              <p className="text-zinc-400">
                Chat ID: <code className="text-zinc-200">{capturedId}</code>
              </p>
            </div>
          ) : capturing ? (
            <div className="text-sm space-y-3">
              <p className="text-zinc-300">
                Open Telegram and send <span className="font-mono">/start</span>{' '}
                {bot ? (
                  <>
                    to{' '}
                    <a
                      className="underline text-zinc-100"
                      href={`https://t.me/${bot.username}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      @{bot.username}
                    </a>
                    .
                  </>
                ) : (
                  'to your bot.'
                )}
              </p>
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-2 text-zinc-400 text-sm">
                  <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                  Waiting for a message…
                </span>
                <button
                  onClick={cancelCapture}
                  className="text-zinc-400 hover:text-zinc-200 text-sm underline"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="text-sm space-y-3">
              <p className="text-zinc-400">
                We'll capture your chat ID from the first message you send the bot.
              </p>
              <button
                onClick={startCapture}
                disabled={step < 3}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium"
              >
                Start listening
              </button>
            </div>
          )}
          {captureError && (
            <p className="text-red-400 text-sm mt-2">{captureError}</p>
          )}
        </StepCard>
      </ol>

      {step === 4 && (
        <div className="mt-8 p-6 bg-emerald-950/30 border border-emerald-900/60 rounded-lg flex items-center justify-between">
          <div>
            <h3 className="font-medium text-emerald-200">All set</h3>
            <p className="text-sm text-emerald-300/80 mt-0.5">
              Your chat is linked and the relay is live — message your bot any time.
            </p>
          </div>
          <button
            onClick={finish}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium"
          >
            Go to dashboard
          </button>
        </div>
      )}
    </div>
  );
}

function StepCard({
  n,
  title,
  active,
  done,
  disabled,
  children,
}: {
  n: number;
  title: string;
  active?: boolean;
  done?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li
      className={[
        'rounded-lg border p-5 transition-colors',
        active
          ? 'border-blue-600/60 bg-blue-950/20'
          : done
            ? 'border-emerald-900/60 bg-emerald-950/10'
            : 'border-zinc-800 bg-zinc-900/30',
        disabled ? 'opacity-60' : '',
      ].join(' ')}
    >
      <div className="flex items-start gap-3 mb-3">
        <div
          className={[
            'w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium shrink-0',
            done
              ? 'bg-emerald-600 text-white'
              : active
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-800 text-zinc-400',
          ].join(' ')}
        >
          {done ? '✓' : n}
        </div>
        <h2 className="font-medium pt-0.5">{title}</h2>
      </div>
      <div className="pl-10">{children}</div>
    </li>
  );
}
