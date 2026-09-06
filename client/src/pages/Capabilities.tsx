import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type Capabilities as CapabilitiesData,
  type McpServer,
  type McpStatus,
  type PluginInfo,
  type SkillInfo,
} from '../api';
import { Nav } from '../components/Nav';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** Read-only inventory of the host's Claude Code: MCP servers, skills, plugins. */
export function Capabilities() {
  const [data, setData] = useState<CapabilitiesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      const d = await api.capabilities();
      setData(d);
      setError(null);
      // Nothing cached yet (first visit) — run one live check automatically.
      if (!d.mcp) refreshMcp();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshMcp = async () => {
    setRefreshing(true);
    try {
      const snap = await api.refreshMcp();
      setData((d) => (d ? { ...d, mcp: snap } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-full max-w-4xl mx-auto px-6 py-10 space-y-8">
      <Nav />
      <header>
        <h1 className="text-2xl font-semibold">Capabilities</h1>
        <p className="text-zinc-400 text-sm mt-1">
          What the Claude Code on this host can reach: connected MCP servers, the skills it
          can invoke, and installed plugins. This page is read-only — to add or change
          anything, just ask over Telegram (see below).
        </p>
      </header>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!data ? (
        <p className="text-zinc-500 text-sm">Loading…</p>
      ) : (
        <>
          <HowToAdd required={data.required_skills} />
          <McpSection
            snapshot={data.mcp}
            refreshing={refreshing}
            onRefresh={refreshMcp}
          />
          <SkillsSection skills={data.skills} />
          <PluginsSection plugins={data.plugins} />
        </>
      )}
    </div>
  );
}

// ── How to add more ─────────────────────────────────────────────────

function Prompt({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2 mt-1.5">
      <span className="text-zinc-600 select-none">›</span>
      <code className="text-zinc-200 text-xs leading-relaxed">“{children}”</code>
      <button
        onClick={() => navigator.clipboard?.writeText(children)}
        className="ml-auto shrink-0 text-[11px] text-zinc-500 hover:text-zinc-300"
        title="Copy prompt"
      >
        copy
      </button>
    </div>
  );
}

function HowToAdd({ required }: { required: CapabilitiesData['required_skills'] }) {
  const missing = required.filter((r) => !r.installed);
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 space-y-4 text-sm">
      <h2 className="font-medium text-zinc-100">How to add more — no SSH needed</h2>

      {missing.length > 0 && (
        <div className="rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          Missing required skill{missing.length > 1 ? 's' : ''}:{' '}
          {missing.map((m) => (
            <code key={m.name} className="text-amber-100 mr-1">
              {m.name}
            </code>
          ))}
          — without it Claude can't finish sign-ins from Telegram. On the host run{' '}
          <code className="text-amber-100">bin/install</code>, or ask in Telegram:
          <Prompt>Install the pty-oauth-login skill from terryds/skills</Prompt>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-zinc-200 font-medium">Connectors on your Claude account</div>
          <p className="text-zinc-400 text-xs mt-1 leading-relaxed">
            Google Drive, Gmail, Notion, Canva… connect them once in Claude Desktop or
            claude.ai under <span className="text-zinc-300">Settings → Connectors</span>. They
            follow your account, so every Claude Code signed in as you — including this host —
            gets them automatically. They show up above as{' '}
            <code className="text-zinc-300">claude.ai …</code>. Nothing to do here.
          </p>
        </div>
        <div>
          <div className="text-zinc-200 font-medium">MCP servers on this machine</div>
          <p className="text-zinc-400 text-xs mt-1 leading-relaxed">
            Ask Claude in Telegram. It adds the server, sends you the sign-in link, you open it
            on your phone and paste back the code or the redirect URL it lands on (a{' '}
            <code className="text-zinc-300">localhost</code> one is fine) — Claude finishes the
            login for you.
          </p>
          <Prompt>Add the Notion MCP server at https://mcp.notion.com/mcp and sign me in</Prompt>
          <Prompt>Sign in to the posthog MCP server</Prompt>
        </div>
        <div>
          <div className="text-zinc-200 font-medium">Skills</div>
          <p className="text-zinc-400 text-xs mt-1 leading-relaxed">
            Any skill on GitHub or{' '}
            <a
              className="underline hover:text-zinc-200"
              href="https://skills.sh"
              target="_blank"
              rel="noreferrer"
            >
              skills.sh
            </a>{' '}
            — Claude installs it with the skills.sh CLI into{' '}
            <code className="text-zinc-300">~/.claude/skills</code>.
          </p>
          <Prompt>Install the frontend-design skill from anthropics/skills</Prompt>
        </div>
        <div>
          <div className="text-zinc-200 font-medium">Plugins</div>
          <p className="text-zinc-400 text-xs mt-1 leading-relaxed">
            Bundles of skills, agents and MCP servers from a marketplace.
          </p>
          <Prompt>Install the posthog plugin from the official Claude plugin marketplace</Prompt>
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        Changes appear here on reload; hit <span className="text-zinc-400">Refresh</span> under
        MCP servers to re-check connections.
      </p>
    </section>
  );
}

// ── MCP servers ─────────────────────────────────────────────────────

const STATUS_STYLE: Record<McpStatus, { dot: string; text: string }> = {
  connected: { dot: 'bg-emerald-400', text: 'text-emerald-300' },
  needs_auth: { dot: 'bg-amber-400', text: 'text-amber-300' },
  failed: { dot: 'bg-red-400', text: 'text-red-300' },
  pending: { dot: 'bg-zinc-400', text: 'text-zinc-300' },
  unknown: { dot: 'bg-zinc-500', text: 'text-zinc-400' },
};

function McpSection({
  snapshot,
  refreshing,
  onRefresh,
}: {
  snapshot: CapabilitiesData['mcp'];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const servers = snapshot?.servers ?? [];
  const connected = servers.filter((s) => s.status === 'connected').length;

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-sm uppercase tracking-wide text-zinc-400">
          MCP servers
          {snapshot && (
            <span className="ml-2 normal-case tracking-normal text-zinc-500">
              {connected}/{servers.length} connected
            </span>
          )}
        </h2>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          {snapshot && !refreshing && <span>Checked {timeAgo(snapshot.checked_at)}</span>}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded text-sm text-zinc-200"
          >
            {refreshing ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 divide-y divide-zinc-800">
        {!snapshot && refreshing ? (
          <p className="p-5 text-sm text-zinc-500">Checking MCP server health…</p>
        ) : snapshot?.error ? (
          <pre className="p-5 text-xs text-red-300/90 whitespace-pre-wrap">{snapshot.error}</pre>
        ) : servers.length === 0 ? (
          <p className="p-5 text-sm text-zinc-500">
            No MCP servers configured. Add one with{' '}
            <code className="text-zinc-300">claude mcp add …</code> on the host.
          </p>
        ) : (
          servers.map((s) => <McpRow key={s.name} server={s} />)
        )}
      </div>
      {servers.some((s) => s.status === 'needs_auth') && (
        <p className="mt-2 text-xs text-zinc-500">
          “Needs authentication” means configured but not signed in. For{' '}
          <code className="text-zinc-400">claude.ai …</code> connectors, authorize them in
          claude.ai → Settings → Connectors. For anything else, ask in Telegram: “Sign in to
          the &lt;name&gt; MCP server” — Claude sends you the link and finishes the login.
        </p>
      )}
    </section>
  );
}

function McpRow({ server }: { server: McpServer }) {
  const st = STATUS_STYLE[server.status];
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-3">
      <div className="min-w-0">
        <div className="font-medium text-sm text-zinc-100 truncate">{server.name}</div>
        <div className="text-xs text-zinc-500 font-mono truncate mt-0.5">
          {server.transport && (
            <span className="mr-2 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-sans not-italic">
              {server.transport}
            </span>
          )}
          {server.target}
        </div>
      </div>
      <div className={`flex items-center gap-2 text-xs shrink-0 ${st.text}`}>
        <span className={`w-2 h-2 rounded-full ${st.dot}`} />
        {server.statusText}
      </div>
    </div>
  );
}

// ── Skills ──────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  project: 'Project',
  personal: 'Personal',
  plugin: 'Plugins',
};
const SOURCE_ORDER = ['project', 'personal', 'plugin'];

function SkillsSection({ skills }: { skills: SkillInfo[] }) {
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? skills.filter(
          (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
        )
      : skills;
    const groups = new Map<string, SkillInfo[]>();
    for (const s of filtered) {
      const key = SOURCE_ORDER.includes(s.source) ? s.source : 'other';
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    return [...SOURCE_ORDER, 'other']
      .filter((k) => groups.has(k))
      .map((k) => ({
        key: k,
        label: SOURCE_LABEL[k] ?? 'Other',
        items: groups.get(k)!.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [skills, query]);

  const shown = grouped.reduce((n, g) => n + g.items.length, 0);

  return (
    <section>
      <div className="flex items-center justify-between gap-4 mb-3">
        <h2 className="font-medium text-sm uppercase tracking-wide text-zinc-400">
          Skills
          <span className="ml-2 normal-case tracking-normal text-zinc-500">
            {query ? `${shown} of ${skills.length}` : skills.length}
          </span>
        </h2>
        {skills.length > 8 && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter skills…"
            className="w-56 bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-sm"
          />
        )}
      </div>

      {skills.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 text-sm text-zinc-500">
          No skills found. Claude Code reads them from{' '}
          <code className="text-zinc-300">.claude/skills/&lt;name&gt;/SKILL.md</code> in this
          project or your home directory, and from installed plugins.
        </div>
      ) : shown === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 text-sm text-zinc-500">
          No skills match “{query}”.
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map((g) => (
            <SkillGroup key={g.key} label={g.label} items={g.items} expandAll={Boolean(query)} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Long groups (plugins ship hundreds of skills) start collapsed. */
const COLLAPSED_ROWS = 10;

function SkillGroup({
  label,
  items,
  expandAll,
}: {
  label: string;
  items: SkillInfo[];
  expandAll: boolean;
}) {
  const [open, setOpen] = useState(false);
  const collapsible = items.length > COLLAPSED_ROWS + 2;
  const shown = collapsible && !open && !expandAll ? items.slice(0, COLLAPSED_ROWS) : items;
  const hidden = items.length - shown.length;

  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1.5">
        {label} · {items.length}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 divide-y divide-zinc-800">
        {shown.map((s) => (
          <div key={s.name} className="px-5 py-2.5">
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-zinc-100 font-mono">/{s.name}</span>
              {s.plugin && <span className="text-[11px] text-zinc-500">{s.plugin}</span>}
            </div>
            {s.description && (
              <div className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{s.description}</div>
            )}
          </div>
        ))}
        {collapsible && !expandAll && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-full px-5 py-2.5 text-left text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60"
          >
            {open ? 'Show fewer' : `Show ${hidden} more…`}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Plugins ─────────────────────────────────────────────────────────

function PluginsSection({ plugins }: { plugins: PluginInfo[] }) {
  return (
    <section>
      <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
        Plugins
        <span className="ml-2 normal-case tracking-normal text-zinc-500">{plugins.length}</span>
      </h2>
      {plugins.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 text-sm text-zinc-500">
          No plugins installed. Browse them with <code className="text-zinc-300">/plugin</code>{' '}
          inside <code className="text-zinc-300">claude</code>.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {plugins.map((p) => (
            <PluginCard key={p.id} plugin={p} />
          ))}
        </div>
      )}
    </section>
  );
}

function PluginCard({ plugin: p }: { plugin: PluginInfo }) {
  const parts: string[] = [];
  if (p.skills) parts.push(`${p.skills} skill${p.skills === 1 ? '' : 's'}`);
  if (p.agents) parts.push(`${p.agents} agent${p.agents === 1 ? '' : 's'}`);
  if (p.commands) parts.push(`${p.commands} command${p.commands === 1 ? '' : 's'}`);
  if (p.hasMcp) parts.push('MCP server');
  if (p.hasHooks) parts.push('hooks');

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-sm text-zinc-100 truncate">{p.name}</div>
          <div className="text-xs text-zinc-500 truncate">
            v{p.version} · {p.marketplace} · {p.scope}
          </div>
        </div>
        <span
          className={[
            'shrink-0 px-2 py-0.5 rounded-full text-xs border',
            p.enabled
              ? 'bg-emerald-900/40 text-emerald-300 border-emerald-800'
              : 'bg-zinc-800 text-zinc-400 border-zinc-700',
          ].join(' ')}
        >
          {p.enabled ? 'enabled' : 'disabled'}
        </span>
      </div>
      {p.description && <p className="text-xs text-zinc-400 line-clamp-3">{p.description}</p>}
      <div className="text-xs text-zinc-500">
        {parts.length ? parts.join(' · ') : 'No components detected'}
        <span className="text-zinc-600"> · updated {fmtDate(p.lastUpdated)}</span>
      </div>
    </div>
  );
}
