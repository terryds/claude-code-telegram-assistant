import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import {
  api,
  type Bookmark,
  type CommitInfo,
  type EngineId,
  type FeedEvent,
  type GroupCaptureMode,
  type GroupLink,
  type Job,
  type Status,
  type UpdateInfo,
} from '../api';
import { AgentAuth } from '../components/AgentAuth';

type Props = { status: Status; onChange: () => void };

export function Dashboard({ status, onChange }: Props) {
  const [, setLocation] = useLocation();
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const engineLabel =
    status.engines.find((e) => e.id === status.engine)?.label ?? status.engine;

  const loadFeed = async () => {
    try {
      const r = await api.feed(300);
      setEvents(r.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    loadFeed();
    const id = window.setInterval(loadFeed, 3000);
    return () => window.clearInterval(id);
  }, []);

  // Newest events render at the top. Keep the view pinned there as they stream
  // in, but only if the user is already near the top — don't yank them back up
  // while they're scrolled down reading older activity.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (el.scrollTop < 120) el.scrollTop = 0;
  }, [events]);

  const toggleRelay = async () => {
    setBusy('relay');
    setError(null);
    try {
      await api.setRelay(!status.relay_enabled);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const switchEngine = async (id: EngineId) => {
    if (id === status.engine) return;
    setBusy('engine');
    setError(null);
    try {
      await api.setEngine(id);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const resetSession = async () => {
    setBusy('session');
    setError(null);
    try {
      await api.resetSession();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const resetAll = async () => {
    if (!confirm('Reset bot token, chat link, and session? You will need to re-onboard.')) {
      return;
    }
    setBusy('reset');
    setError(null);
    try {
      await api.reset();
      onChange();
      setLocation('/onboarding');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-full max-w-4xl mx-auto px-6 py-10 space-y-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-zinc-400 text-sm mt-1">
            {status.bot ? (
              <>
                Connected to{' '}
                <a
                  className="underline hover:text-zinc-200"
                  href={`https://t.me/${status.bot.username}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  @{status.bot.username}
                </a>{' '}
                · chat <code className="text-zinc-300">{status.chat_id}</code>
              </>
            ) : (
              'No bot connected'
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-full border border-zinc-700 overflow-hidden text-xs font-medium">
            {status.engines.map((e) => (
              <button
                key={e.id}
                onClick={() => switchEngine(e.id)}
                disabled={busy === 'engine'}
                className={[
                  'px-3 py-1 transition-colors disabled:opacity-50',
                  status.engine === e.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800',
                ].join(' ')}
                title="Switch coding agent — starts a fresh conversation"
              >
                {e.label}
              </button>
            ))}
          </div>
          <span
            className={[
              'inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium',
              status.relay_enabled
                ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-800'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-700',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                status.relay_enabled ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500',
              ].join(' ')}
            />
            {status.relay_enabled ? 'Relay on' : 'Relay off'}
          </span>
        </div>
      </header>

      {error && (
        <div className="bg-red-950/40 border border-red-900/60 text-red-200 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          Bookmarks
        </h2>
        <BookmarksCard />
      </section>

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          Scheduled jobs
        </h2>
        <JobsCard />
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button
          onClick={toggleRelay}
          disabled={busy === 'relay'}
          className={[
            'p-4 rounded-lg border text-left transition-colors disabled:opacity-50',
            status.relay_enabled
              ? 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800'
              : 'border-blue-700 bg-blue-950/40 hover:bg-blue-950/60',
          ].join(' ')}
        >
          <div className="font-medium text-sm">
            {status.relay_enabled ? 'Pause relay' : 'Enable relay'}
          </div>
          <div className="text-xs text-zinc-400 mt-1">
            {status.relay_enabled
              ? `Stop forwarding incoming messages to ${engineLabel}.`
              : `Start forwarding incoming messages to ${engineLabel}.`}
          </div>
        </button>

        <button
          onClick={resetSession}
          disabled={busy === 'session'}
          className="p-4 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-left transition-colors disabled:opacity-50"
        >
          <div className="font-medium text-sm">Reset {engineLabel} session</div>
          <div className="text-xs text-zinc-400 mt-1">
            Clears every conversation (private chat and group topic alike).
          </div>
        </button>

        <button
          onClick={resetAll}
          disabled={busy === 'reset'}
          className="p-4 rounded-lg border border-red-900/60 bg-red-950/20 hover:bg-red-950/40 text-left transition-colors disabled:opacity-50"
        >
          <div className="font-medium text-sm text-red-200">Reset everything</div>
          <div className="text-xs text-red-300/70 mt-1">
            Clear bot token, chat link, and session.
          </div>
        </button>
      </section>

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          Persona
        </h2>
        <PersonaCard />
      </section>

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          Group topics
        </h2>
        <GroupTopicCard
          groups={status.groups}
          botUsername={status.bot?.username ?? null}
          onChange={onChange}
        />
      </section>

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          {engineLabel} authentication
        </h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5">
          {/* Re-mount when the active engine changes so config reloads. Skip the
              auto-probe here — probing costs a request; the user clicks Check. */}
          <AgentAuth key={status.engine} engine={status.engine} autoProbe={false} />
        </div>
      </section>

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          Updates
        </h2>
        <UpdateCard />
      </section>

      <section>
        <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
          Activity
        </h2>
        {events.length === 0 ? (
          <p className="text-zinc-500 text-sm">No activity yet.</p>
        ) : (
          <div
            ref={feedRef}
            className="max-h-[65vh] overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2"
          >
            {events.map((e) => (
              <FeedItem key={`${e.etype}-${e.id}`} event={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PersonaCard() {
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [custom, setCustom] = useState(false);
  const [defaultPersona, setDefaultPersona] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .persona()
      .then((r) => {
        setText(r.persona);
        setSaved(r.persona);
        setCustom(r.custom);
        setDefaultPersona(r.default_persona);
        setLoaded(true);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const dirty = text !== saved;

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.setPersona(value);
      setText(r.persona);
      setSaved(r.persona);
      setCustom(r.custom);
      setNotice('Saved — the next Telegram message starts a fresh conversation with it.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 text-sm text-zinc-500">
        {error ?? 'Loading…'}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 space-y-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-zinc-400 text-xs">
          Who the assistant is to you on Telegram. Injected at the start of every
          conversation — also editable via <code className="text-zinc-300">/persona</code> in chat.
        </p>
        <span
          className={[
            'shrink-0 px-2 py-0.5 rounded-full text-xs font-medium border',
            custom
              ? 'bg-blue-950/40 text-blue-300 border-blue-800'
              : 'bg-zinc-800 text-zinc-400 border-zinc-700',
          ].join(' ')}
        >
          {custom ? 'Customized' : 'Default'}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setNotice(null);
        }}
        rows={7}
        spellCheck={false}
        className="w-full rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5 font-mono text-xs leading-relaxed resize-y focus:outline-none focus:border-zinc-600"
      />
      {error && <p className="text-red-300 text-xs">{error}</p>}
      {notice && <p className="text-emerald-300 text-xs">{notice}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => save(text)}
          disabled={busy || !dirty || !text.trim()}
          className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
        >
          Save persona
        </button>
        {custom && (
          <button
            onClick={() => save('')}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs transition-colors disabled:opacity-50"
          >
            Reset to default
          </button>
        )}
        {!custom && dirty && (
          <button
            onClick={() => setText(defaultPersona)}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs transition-colors disabled:opacity-50"
          >
            Discard changes
          </button>
        )}
        <span className="text-zinc-500 text-xs">
          Saving stops in-flight runs and starts fresh conversations.
        </span>
      </div>
    </div>
  );
}

function JobsCard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [openOutput, setOpenOutput] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.jobs();
      setJobs(r.jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
    // The agent registers jobs from Telegram runs, and run states change on
    // their own — keep the list fresh.
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, []);

  const withBusy = async (id: number, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const fmt = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const statusDot = (j: Job) => {
    if (!j.enabled) return 'bg-zinc-600';
    if (j.running) return 'bg-blue-400 animate-pulse';
    if (j.last_run_at === null) return 'bg-zinc-400';
    return j.last_exit_code === 0 ? 'bg-emerald-400' : 'bg-red-400';
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 space-y-3">
      {error && <p className="text-red-300 text-sm">{error}</p>}
      {loaded && jobs.length === 0 && (
        <p className="text-zinc-500 text-sm">
          No scheduled jobs yet. Ask the agent over Telegram to watch something —
          e.g. “check the bitcoin price every hour and tell me if it drops below
          $50k” — and it will create one.
        </p>
      )}
      {jobs.map((j) => (
        <div
          key={j.id}
          className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <div className="flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(j)}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-medium text-sm">{j.name}</span>
                <code className="text-xs text-zinc-400">{j.schedule} UTC</code>
                {!j.enabled && (
                  <span className="text-xs text-zinc-500">(paused)</span>
                )}
              </div>
              {j.description && (
                <p className="text-xs text-zinc-400 mt-0.5 truncate">{j.description}</p>
              )}
              <p className="text-xs text-zinc-500 mt-0.5">
                {j.running
                  ? 'running now…'
                  : j.last_run_at
                    ? `last run ${fmt(j.last_run_at)}${
                        j.last_exit_code === 0 ? '' : ` — failed (exit ${j.last_exit_code})`
                      }`
                    : 'never ran yet'}
                {j.enabled && j.next_run_at ? ` · next ${fmt(j.next_run_at)}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {j.last_output && (
                <button
                  onClick={() => setOpenOutput(openOutput === j.id ? null : j.id)}
                  className="px-2 py-1 rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                  title="Show last output"
                >
                  {openOutput === j.id ? 'Hide output' : 'Output'}
                </button>
              )}
              <button
                onClick={() => withBusy(j.id, () => api.runJob(j.id))}
                disabled={busyId === j.id || j.running}
                className="px-2 py-1 rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors disabled:opacity-50"
                title="Run once now (delivers output to Telegram)"
              >
                Run now
              </button>
              <button
                onClick={() =>
                  withBusy(j.id, () => api.updateJob(j.id, { enabled: !j.enabled }))
                }
                disabled={busyId === j.id}
                className="px-2 py-1 rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors disabled:opacity-50"
              >
                {j.enabled ? 'Pause' : 'Resume'}
              </button>
              <button
                onClick={() => {
                  if (!confirm(`Remove scheduled job "${j.name}"?`)) return;
                  withBusy(j.id, () => api.deleteJob(j.id));
                }}
                disabled={busyId === j.id}
                className="px-2 py-1 rounded text-xs text-zinc-500 hover:bg-red-950/40 hover:text-red-300 transition-colors disabled:opacity-50"
                title="Remove job"
              >
                ✕
              </button>
            </div>
          </div>
          {openOutput === j.id && j.last_output && (
            <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-950 border border-zinc-800 p-2 text-xs text-zinc-300 whitespace-pre-wrap">
              {j.last_output}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function BookmarksCard() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Which form is open: 'add', a bookmark id (edit), or null.
  const [editing, setEditing] = useState<'add' | number | null>(null);
  const [formUrl, setFormUrl] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.bookmarks();
      setBookmarks(r.bookmarks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
    // The agent adds bookmarks from Telegram runs — pick those up while the
    // dashboard sits open, without hammering the API.
    const id = window.setInterval(load, 15000);
    return () => window.clearInterval(id);
  }, []);

  const openAdd = () => {
    setEditing('add');
    setFormUrl('');
    setFormTitle('');
    setError(null);
  };

  const openEdit = (b: Bookmark) => {
    setEditing(b.id);
    setFormUrl(b.url);
    setFormTitle(b.title);
    setError(null);
  };

  const closeForm = () => {
    setEditing(null);
    setError(null);
  };

  const submit = async () => {
    const url = formUrl.trim();
    if (!url) return;
    setSaving(true);
    setError(null);
    try {
      if (editing === 'add') {
        await api.addBookmark({ url, title: formTitle.trim() || undefined });
      } else if (typeof editing === 'number') {
        await api.updateBookmark(editing, { url, title: formTitle.trim() || undefined });
      }
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const refreshMeta = async () => {
    if (typeof editing !== 'number') return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.refreshBookmark(editing);
      if (!r.reachable) {
        setError("Couldn't reach the page — kept the existing title and icon.");
      } else {
        setEditing(null);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (b: Bookmark) => {
    if (!confirm(`Remove bookmark "${b.title}"?`)) return;
    setBusyId(b.id);
    setError(null);
    try {
      await api.deleteBookmark(b.id);
      if (editing === b.id) setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const formOpen = editing !== null;

  return (
    <div className="space-y-3">
      {loaded && bookmarks.length === 0 && !formOpen && (
        <p className="text-zinc-400 text-sm">
          Quick links to your other apps — anything running on another port or host.
          New projects the agent deploys get added here automatically.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {bookmarks.map((b) => (
          <div
            key={b.id}
            className="group relative rounded-lg border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/70 hover:border-zinc-700 transition-colors"
          >
            <a
              href={b.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 p-3 pr-16"
              title={b.url}
            >
              <BookmarkIcon bookmark={b} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-100 truncate">
                  {b.title}
                </span>
                <span className="block text-xs text-zinc-500 truncate">
                  {displayHost(b.url)}
                </span>
              </span>
            </a>
            <span className="absolute top-1/2 -translate-y-1/2 right-2 flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
              <button
                onClick={() => openEdit(b)}
                className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
                title="Edit bookmark"
                aria-label={`Edit ${b.title}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
              <button
                onClick={() => remove(b)}
                disabled={busyId === b.id}
                className="p-1.5 rounded text-zinc-400 hover:text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                title="Remove bookmark"
                aria-label={`Remove ${b.title}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          </div>
        ))}

        {!formOpen && loaded && (
          <button
            onClick={openAdd}
            className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-zinc-200 p-3 text-sm transition-colors min-h-[3.5rem]"
          >
            <span className="text-base leading-none">+</span> Add bookmark
          </button>
        )}
      </div>

      {formOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-4 space-y-3 text-sm"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-zinc-500 mb-1">
                URL
              </span>
              <input
                autoFocus
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="myapp.example.com:3001"
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-600"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-zinc-500 mb-1">
                Title <span className="normal-case text-zinc-600">(optional)</span>
              </span>
              <input
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="Fetched from the page if left empty"
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-600"
              />
            </label>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="submit"
              disabled={saving || !formUrl.trim()}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
            >
              {saving
                ? 'Fetching title & icon…'
                : editing === 'add'
                  ? 'Add'
                  : 'Save'}
            </button>
            {typeof editing === 'number' && (
              <button
                type="button"
                onClick={refreshMeta}
                disabled={saving}
                className="px-3 py-1.5 border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 rounded text-sm disabled:opacity-50"
                title="Fetch the page again and update its title and icon"
              >
                Re-fetch title & icon
              </button>
            )}
            <button
              type="button"
              onClick={closeForm}
              disabled={saving}
              className="text-zinc-400 hover:text-zinc-200 underline disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-red-400">{error}</p>}
        </form>
      )}

      {error && !formOpen && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}

/** Favicon if we have one; otherwise a colored letter tile derived from the host. */
function BookmarkIcon({ bookmark }: { bookmark: Bookmark }) {
  const [broken, setBroken] = useState(false);
  if (bookmark.favicon && !broken) {
    return (
      <img
        src={bookmark.favicon}
        alt=""
        onError={() => setBroken(true)}
        className="w-6 h-6 rounded shrink-0 object-contain"
      />
    );
  }
  const letter = (bookmark.title.trim()[0] ?? '?').toUpperCase();
  const hue = hostHue(bookmark.url);
  return (
    <span
      className="w-6 h-6 rounded shrink-0 flex items-center justify-center text-xs font-semibold text-white"
      style={{ backgroundColor: `hsl(${hue} 45% 40%)` }}
      aria-hidden
    >
      {letter}
    </span>
  );
}

function hostHue(url: string): number {
  let h = 0;
  const s = displayHost(url);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function displayHost(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

function UpdateCard() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [check, setCheck] = useState<{ behind: number; commits: CommitInfo[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const loadInfo = async () => {
    try {
      const r = await api.updateInfo();
      setInfo(r);
      // A restart may have happened while this page was open — an update
      // "running" per the state file means we should be in the polling UI.
      if (r.running) setUpdating(true);
      return r;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    loadInfo();
  }, []);

  const runCheck = async () => {
    setError(null);
    setChecking(true);
    try {
      const r = await api.updateCheck();
      setCheck({ behind: r.behind, commits: r.commits });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const runUpdate = async () => {
    if (!confirm('Pull the latest version, rebuild, and restart the relay?')) return;
    setError(null);
    try {
      await api.updateRun();
      setUpdating(true);
      setCheck(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // While updating, poll until the (restarted) server reports the outcome.
  // Fetch failures are expected mid-restart — keep polling through them.
  useEffect(() => {
    if (!updating) return;
    let stopped = false;
    const tick = async () => {
      const r = await loadInfo();
      if (stopped) return;
      if (r && !r.running) {
        setUpdating(false);
        return;
      }
      pollRef.current = window.setTimeout(tick, 2000);
    };
    pollRef.current = window.setTimeout(tick, 2000);
    return () => {
      stopped = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [updating]);

  const state = info?.state ?? null;
  const outcome =
    !updating && state && state.phase !== 'running'
      ? state.phase === 'success'
        ? state.old && state.new && state.old !== state.new
          ? `Last update: ✅ ${state.old} → ${state.new}`
          : 'Last update: ✅ already up to date (rebuilt + restarted)'
        : `Last update: ❌ failed at ${state.step ?? '?'}${state.detail ? ` — ${state.detail}` : ''}`
      : null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 text-sm space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-zinc-100">
            Current version:{' '}
            {info?.current ? (
              <>
                <code className="text-zinc-300">{info.current.sha}</code>{' '}
                <span className="text-zinc-400">{info.current.subject}</span>
              </>
            ) : (
              <span className="text-zinc-500">unknown</span>
            )}
          </p>
          {info?.current?.date && (
            <p className="text-zinc-500 text-xs mt-0.5">
              committed {new Date(info.current.date).toLocaleString()}
            </p>
          )}
        </div>
        {!updating && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={runCheck}
              disabled={checking}
              className="px-3 py-1.5 border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 rounded text-xs font-medium disabled:opacity-50"
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            {info?.managed && check && check.behind > 0 && (
              <button
                onClick={runUpdate}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-medium"
              >
                Update now
              </button>
            )}
          </div>
        )}
      </div>

      {updating ? (
        <div className="flex items-center gap-2 text-zinc-300">
          <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          Updating — pull, build, restart. The dashboard will reconnect by itself…
        </div>
      ) : (
        <>
          {check &&
            (check.behind === 0 ? (
              <p className="text-emerald-400">Up to date.</p>
            ) : (
              <div className="space-y-1">
                <p className="text-zinc-200">
                  Update available — {check.behind} commit{check.behind === 1 ? '' : 's'} behind:
                </p>
                <ul className="text-xs text-zinc-400 space-y-0.5">
                  {check.commits.map((c) => (
                    <li key={c.sha}>
                      <code className="text-zinc-500">{c.sha}</code> {c.subject}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          {info && !info.managed && (
            <p className="text-zinc-500 text-xs">
              Not running under pm2 — updates must be applied manually (git pull, bun run
              build, restart). You can also send <code>/update</code> to the bot when
              deployed.
            </p>
          )}
          {outcome && <p className="text-zinc-500 text-xs">{outcome}</p>}
        </>
      )}

      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}

function GroupTopicCard({
  groups,
  botUsername,
  onChange,
}: {
  groups: GroupLink[];
  botUsername: string | null;
  onChange: () => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [mode, setMode] = useState<GroupCaptureMode>('topic');
  const [busy, setBusy] = useState(false);
  const [unlinking, setUnlinking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const startCapture = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.groupStartCapture(mode);
      setCapturing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelCapture = async () => {
    try {
      await api.groupCancelCapture();
    } catch {
      // ignore
    }
    setCapturing(false);
  };

  const unlink = async (id: number) => {
    setError(null);
    setUnlinking(id);
    try {
      await api.groupUnlink(id);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlinking(null);
    }
  };

  // While listening, poll until the server reports the capture finished.
  useEffect(() => {
    if (!capturing) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await api.groupStatus();
        if (!r.capturing) {
          setCapturing(false);
          onChange();
          return;
        }
      } catch {
        // keep polling
      }
      if (!stopped) pollRef.current = window.setTimeout(tick, 1500);
    };
    tick();
    return () => {
      stopped = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [capturing]);

  const bot = botUsername ? `@${botUsername}` : 'your bot';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 text-sm space-y-3">
      {groups.length > 0 ? (
        <div className="space-y-2">
          {groups.map((g) => (
            <div
              key={g.id}
              className="flex items-center justify-between gap-3 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-zinc-100 truncate">
                  <span className="font-medium">{g.chat_title ?? g.chat_id}</span>
                  {' · '}
                  {g.topic_id ? (
                    <>topic {g.topic_name ? <span className="font-medium">{g.topic_name}</span> : <code>{g.topic_id}</code>}</>
                  ) : (
                    <span className="text-zinc-300">entire group</span>
                  )}
                </p>
                <p className="text-zinc-500 text-xs">
                  Chat ID: <code className="text-zinc-400">{g.chat_id}</code>
                  {g.topic_id && (
                    <>
                      {' '}· Topic ID: <code className="text-zinc-400">{g.topic_id}</code>
                    </>
                  )}
                </p>
              </div>
              <button
                onClick={() => unlink(g.id)}
                disabled={unlinking === g.id}
                className="shrink-0 px-3 py-1.5 border border-red-900/60 bg-red-950/20 hover:bg-red-950/40 text-red-200 rounded text-xs font-medium disabled:opacity-50"
              >
                {unlinking === g.id ? 'Unlinking…' : 'Unlink'}
              </button>
            </div>
          ))}
          <p className="text-zinc-500 text-xs">
            Each link is its own conversation with its own session — topic links only react
            inside that exact topic; whole-group links react to every message in the group.
            Your private chat keeps working as usual.
          </p>
        </div>
      ) : (
        <p className="text-zinc-400">
          Optionally link group topics — the relay answers there in addition to your
          private chat, each with its own separate conversation.
        </p>
      )}

      {capturing ? (
        <div className="space-y-3">
          <ol className="list-decimal list-inside text-zinc-300 space-y-1">
            <li>
              Add <span className="font-mono">{bot}</span> to your group (if it isn't already).
            </li>
            <li>
              Make sure the bot can see messages: either disable privacy mode via{' '}
              <a
                className="underline text-zinc-100"
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
              >
                @BotFather
              </a>{' '}
              (<span className="font-mono">/setprivacy</span> → Disable) or make the bot a
              group admin.
            </li>
            {mode === 'topic' ? (
              <>
                <li>
                  Enable <span className="font-medium">Topics</span> in the group settings and
                  create your topic (if you haven't yet).
                </li>
                <li>Send any message inside that topic.</li>
              </>
            ) : (
              <li>Send any message in the group.</li>
            )}
          </ol>
          {mode === 'topic' && (
            <p className="text-zinc-500 text-xs">
              Messages outside a topic are ignored while linking — the bot replies with a
              hint and keeps waiting until it sees a topic message.
            </p>
          )}
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 text-zinc-400">
              <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
              {mode === 'topic'
                ? 'Waiting for a message in a topic…'
                : 'Waiting for a message in the group…'}
            </span>
            <button
              onClick={cancelCapture}
              className="text-zinc-400 hover:text-zinc-200 underline"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1.5">
              Link scope
            </div>
            <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden text-sm font-medium">
              {(
                [
                  { id: 'topic', label: 'Specific topic' },
                  { id: 'group', label: 'Entire group' },
                ] as Array<{ id: GroupCaptureMode; label: string }>
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  disabled={busy}
                  className={[
                    'px-3 py-1.5 transition-colors disabled:opacity-50',
                    mode === m.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800',
                  ].join(' ')}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-zinc-500 text-xs mt-1.5">
              {mode === 'topic'
                ? 'Link one forum topic — the bot only reacts inside that topic.'
                : 'Link the whole group — the bot reacts to every message in it.'}
            </p>
          </div>
          <button
            onClick={startCapture}
            disabled={busy}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-medium"
          >
            {groups.length > 0 ? 'Add another group topic' : 'Add a group topic'}
          </button>
        </div>
      )}

      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}

function FeedItem({ event }: { event: FeedEvent }) {
  const ts = new Date(event.created_at).toLocaleTimeString();

  if (event.etype === 'step') {
    if (event.kind === 'thinking') {
      return (
        <Row label="🧠 thinking" ts={ts} tone="muted">
          <span className="italic text-zinc-400">…</span>
        </Row>
      );
    }
    if (event.kind === 'tool_use') {
      return (
        <Row label={`🛠 ${event.tool_name ?? '?'}`} ts={ts} tone="tool">
          {event.tool_input && <Pre>{event.tool_input}</Pre>}
        </Row>
      );
    }
    // tool_result
    return (
      <Row label="✅ result" ts={ts} tone="result">
        {event.result_text && <Pre>{event.result_text}</Pre>}
      </Row>
    );
  }

  // message
  const isIn = event.direction === 'in';
  return (
    <Row
      label={isIn ? '→ Telegram' : '← Agent'}
      ts={ts}
      tone={isIn ? 'in' : event.ok ? 'out' : 'error'}
      session={event.session_id}
    >
      <div className="whitespace-pre-wrap break-words text-zinc-100">
        {event.error ? (
          <span className="text-red-300">{event.error}</span>
        ) : (
          truncate(event.text, 600)
        )}
      </div>
    </Row>
  );
}

const TONES: Record<string, string> = {
  in: 'border-zinc-800 bg-zinc-900/40',
  out: 'border-blue-900/40 bg-blue-950/20',
  error: 'border-red-900/40 bg-red-950/20',
  muted: 'border-zinc-800/60 bg-zinc-900/20',
  tool: 'border-amber-900/40 bg-amber-950/10',
  result: 'border-emerald-900/40 bg-emerald-950/10',
};

function Row({
  label,
  ts,
  tone,
  session,
  children,
}: {
  label: string;
  ts: string;
  tone: keyof typeof TONES | string;
  session?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className={['rounded border px-3 py-2 text-sm', TONES[tone] ?? TONES.in].join(' ')}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
        <span className="text-xs text-zinc-600">{ts}</span>
      </div>
      <div className="font-mono text-xs text-zinc-200">{children}</div>
      {session && (
        <div className="text-[10px] text-zinc-600 mt-1 font-mono">
          session {session.slice(0, 8)}
        </div>
      )}
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words text-zinc-300 mt-0.5">{children}</pre>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `… (+${s.length - n} chars)`;
}
