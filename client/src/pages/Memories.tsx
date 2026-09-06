import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  type InstructionFile,
  type MemoriesReport,
  type MemoryEntry,
  type MemoryProject,
} from '../api';
import { Nav } from '../components/Nav';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** Read-only view of Claude Code's auto-memory and instruction files on this host. */
export function Memories() {
  const [data, setData] = useState<MemoriesReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .memories()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="min-h-full max-w-4xl mx-auto px-6 py-10 space-y-8">
      <Nav />
      <header>
        <h1 className="text-2xl font-semibold">Memories</h1>
        <p className="text-zinc-400 text-sm mt-1">
          What Claude Code remembers across conversations on this host: the memories it saves
          on its own, plus the instruction files it reads at the start of every run. Read-only —
          to change anything, just tell Claude in Telegram.
        </p>
      </header>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!data ? (
        <p className="text-zinc-500 text-sm">Loading…</p>
      ) : (
        <>
          <HowTo />
          <CurrentProject project={data.current} cwd={data.cwd} />
          <Instructions files={data.instructions} />
          <OtherProjects projects={data.others} />
        </>
      )}
    </div>
  );
}

// ── How to ──────────────────────────────────────────────────────────

function Prompt({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(children).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={copy}
      title="Copy this message"
      className="group flex w-full items-center gap-3 text-left rounded-xl border border-zinc-800 bg-zinc-900 hover:border-zinc-700 hover:bg-zinc-800/80 px-4 py-2.5 transition-colors"
    >
      <span className="text-zinc-100 text-sm leading-snug">{children}</span>
      <span className="ml-auto shrink-0 text-xs text-zinc-500 group-hover:text-zinc-300">
        {copied ? 'Copied ✓' : 'Copy'}
      </span>
    </button>
  );
}

function HowTo() {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 space-y-3">
      <div>
        <h2 className="font-medium text-zinc-100">How memory works</h2>
        <p className="text-zinc-400 text-sm mt-1 leading-relaxed">
          Claude saves one small file per fact it decides is worth keeping — your preferences,
          corrections you've given it, project context — and reads the index back at the start
          of every conversation. It also picks things up on its own, but you can steer it
          directly. Tap an example to copy it.
        </p>
      </div>
      <div className="space-y-1.5">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500">Say in Telegram</div>
        <Prompt>Remember that I prefer replies in Bahasa Indonesia</Prompt>
        <Prompt>Forget what you saved about my deploy preferences</Prompt>
        <Prompt>What do you remember about me?</Prompt>
      </div>
    </section>
  );
}

// ── Sections ────────────────────────────────────────────────────────

function SectionTitle({ children, count }: { children: string; count?: number | string }) {
  return (
    <h2 className="font-medium mb-3 text-sm uppercase tracking-wide text-zinc-400">
      {children}
      {count !== undefined && (
        <span className="ml-2 normal-case tracking-normal text-zinc-500">{count}</span>
      )}
    </h2>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5 text-sm text-zinc-500">
      {children}
    </div>
  );
}

function CurrentProject({ project, cwd }: { project: MemoryProject | null; cwd: string }) {
  const memories = project?.memories ?? [];
  return (
    <section>
      <SectionTitle count={memories.length}>Memories</SectionTitle>
      <p className="text-xs text-zinc-500 mb-3 font-mono truncate" title={project?.dir ?? cwd}>
        {project?.dir ?? cwd}
      </p>
      {memories.length === 0 ? (
        <Empty>
          Nothing saved yet. Claude writes memories here as you work together — or tell it
          something to remember.
        </Empty>
      ) : (
        <MemoryList memories={memories} />
      )}
    </section>
  );
}

const TYPE_STYLE: Record<string, string> = {
  user: 'bg-sky-900/40 text-sky-300 border-sky-800',
  feedback: 'bg-amber-900/40 text-amber-300 border-amber-800',
  project: 'bg-emerald-900/40 text-emerald-300 border-emerald-800',
  reference: 'bg-violet-900/40 text-violet-300 border-violet-800',
};

function MemoryList({ memories }: { memories: MemoryEntry[] }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 divide-y divide-zinc-800">
      {memories.map((m) => (
        <MemoryRow key={m.id} memory={m} />
      ))}
    </div>
  );
}

function MemoryRow({ memory: m }: { memory: MemoryEntry }) {
  const [open, setOpen] = useState(false);
  const style = TYPE_STYLE[m.type] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700';
  return (
    <div className="px-5 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left flex items-start gap-3"
        aria-expanded={open}
      >
        <span className="text-zinc-600 mt-0.5 select-none">{open ? '▾' : '▸'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-zinc-100 font-medium">{m.name}</span>
            <span className={`px-1.5 py-0.5 rounded-full text-[11px] border ${style}`}>{m.type}</span>
            {m.modified && (
              <span className="text-[11px] text-zinc-600">{fmtDate(m.modified)}</span>
            )}
          </div>
          {m.description && (
            <div className="text-xs text-zinc-400 mt-0.5 leading-relaxed">{m.description}</div>
          )}
        </div>
      </button>
      {open && (
        <pre className="mt-3 ml-6 text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed bg-zinc-950/60 border border-zinc-800 rounded p-3 overflow-x-auto">
          {m.body || '(empty)'}
        </pre>
      )}
    </div>
  );
}

function Instructions({ files }: { files: InstructionFile[] }) {
  return (
    <section>
      <SectionTitle count={files.length}>Instruction files</SectionTitle>
      <p className="text-xs text-zinc-500 mb-3">
        Prepended to every run. Project files live in the relay's directory; a global one applies
        to every project on this host.
      </p>
      {files.length === 0 ? (
        <Empty>
          No CLAUDE.md, AGENTS.md or rules files found. Create one to give Claude standing
          instructions.
        </Empty>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 divide-y divide-zinc-800">
          {files.map((f) => (
            <InstructionRow key={f.path} file={f} />
          ))}
        </div>
      )}
    </section>
  );
}

function InstructionRow({ file: f }: { file: InstructionFile }) {
  const [open, setOpen] = useState(false);
  const lines = f.content.split('\n').length;
  return (
    <div className="px-5 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left flex items-center gap-3"
        aria-expanded={open}
      >
        <span className="text-zinc-600 select-none">{open ? '▾' : '▸'}</span>
        <span className="text-sm text-zinc-100 font-mono">{f.label}</span>
        <span
          className={[
            'px-1.5 py-0.5 rounded-full text-[11px] border',
            f.scope === 'global'
              ? 'bg-violet-900/40 text-violet-300 border-violet-800'
              : 'bg-zinc-800 text-zinc-400 border-zinc-700',
          ].join(' ')}
        >
          {f.scope}
        </span>
        <span className="ml-auto text-[11px] text-zinc-600 shrink-0">
          {lines} lines{f.modified ? ` · ${fmtDate(f.modified)}` : ''}
        </span>
      </button>
      {open && (
        <pre className="mt-3 ml-6 text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed bg-zinc-950/60 border border-zinc-800 rounded p-3 overflow-x-auto max-h-[32rem] overflow-y-auto">
          {f.content}
        </pre>
      )}
    </div>
  );
}

function OtherProjects({ projects }: { projects: MemoryProject[] }) {
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return null;
  const total = projects.reduce((n, p) => n + p.memories.length, 0);
  return (
    <section>
      <SectionTitle count={`${projects.length} projects · ${total} memories`}>
        Other projects on this host
      </SectionTitle>
      <p className="text-xs text-zinc-500 mb-3">
        Memory folders for other directories Claude Code has been run in. Not used by the relay.
      </p>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full text-left px-5 py-3 text-sm text-zinc-300 hover:bg-zinc-900/60 flex items-center gap-3"
          aria-expanded={open}
        >
          <span className="text-zinc-600 select-none">{open ? '▾' : '▸'}</span>
          {open ? 'Hide' : 'Show'} other projects
        </button>
        {open && (
          <div className="border-t border-zinc-800 divide-y divide-zinc-800">
            {projects.map((p) => (
              <ProjectBlock key={p.slug} project={p} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ProjectBlock({ project: p }: { project: MemoryProject }) {
  const [open, setOpen] = useState(false);
  const label = p.cwd ?? p.slug;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-5 py-2.5 flex items-center gap-3 hover:bg-zinc-900/60"
        aria-expanded={open}
      >
        <span className="text-zinc-600 select-none">{open ? '▾' : '▸'}</span>
        <span className="text-sm text-zinc-200 font-mono truncate" title={p.dir}>
          {label}
        </span>
        <span className="ml-auto text-[11px] text-zinc-500 shrink-0">
          {p.memories.length} {p.memories.length === 1 ? 'memory' : 'memories'}
        </span>
      </button>
      {open && (
        <div className="px-5 pb-3">
          {p.memories.length ? (
            <MemoryList memories={p.memories} />
          ) : (
            <p className="text-xs text-zinc-500">Only an index file, no memories.</p>
          )}
        </div>
      )}
    </div>
  );
}
