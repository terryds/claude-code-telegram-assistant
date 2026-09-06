/**
 * Read-only view of what Claude Code remembers on this host, for the
 * dashboard's Memories page:
 *
 *  - Auto-memory: `~/.claude/projects/<slug>/memory/*.md` — one file per
 *    memory with YAML frontmatter (name, description, metadata.type) plus a
 *    MEMORY.md index. The relay always runs `claude -p` from process.cwd(),
 *    so that project's folder is "this relay's memory"; other projects on the
 *    host are listed separately.
 *  - Instruction files: CLAUDE.md / AGENTS.md / CLAUDE.local.md /
 *    .claude/rules/*.md in the relay's cwd, and the global ~/.claude/CLAUDE.md.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export type MemoryEntry = {
  /** Filename without .md */
  id: string;
  name: string;
  description: string;
  /** user | feedback | project | reference | (anything else the file says) */
  type: string;
  body: string;
  modified: string | null;
  file: string;
};

export type MemoryProject = {
  slug: string;
  /** Real working directory, when it could be resolved from session logs. */
  cwd: string | null;
  dir: string;
  /** Contents of MEMORY.md (the index), if present. */
  index: string | null;
  memories: MemoryEntry[];
};

export type InstructionFile = {
  /** Display label, e.g. "CLAUDE.md" or "~/.claude/CLAUDE.md" */
  label: string;
  scope: 'project' | 'global';
  path: string;
  content: string;
  modified: string | null;
};

export type MemoriesReport = {
  cwd: string;
  current: MemoryProject | null;
  instructions: InstructionFile[];
  others: MemoryProject[];
};

// ── Frontmatter ─────────────────────────────────────────────────────

function unquote(v: string): string {
  return v.trim().replace(/^["']|["']$/g, '');
}

/** Minimal YAML frontmatter reader: top-level `key: value` plus `metadata.type`. */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw.trim() };
  const fm: Record<string, string> = {};
  let inMetadata = false;
  for (const line of m[1].split('\n')) {
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top) {
      inMetadata = false;
      fm[top[1]] = unquote(top[2]);
      continue;
    }
    const nested = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (nested && inMetadata) fm[`metadata.${nested[1]}`] = unquote(nested[2]);
  }
  return { fm, body: raw.slice(m[0].length).trim() };
}

function mtime(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

// ── Auto-memory ─────────────────────────────────────────────────────

/** Claude Code names the project folder after the cwd with `/` → `-`. */
export function projectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

function readMemoryDir(dir: string): { index: string | null; memories: MemoryEntry[] } {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { index: null, memories: [] };
  }
  let index: string | null = null;
  const memories: MemoryEntry[] = [];
  for (const f of entries.sort()) {
    if (!f.endsWith('.md')) continue;
    const path = join(dir, f);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (f === 'MEMORY.md') {
      index = raw.trim();
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    const id = basename(f, '.md');
    memories.push({
      id,
      name: fm.name || id,
      description: fm.description || '',
      type: fm['metadata.type'] || fm.type || 'memory',
      body,
      modified: fm['metadata.modified'] || mtime(path),
      file: path,
    });
  }
  return { index, memories };
}

/**
 * Best-effort: recover the real cwd of a project folder from its newest
 * session log (each JSONL line carries a `cwd` field).
 */
function resolveProjectCwd(projectDir: string): string | null {
  try {
    const logs = readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 3);
    for (const { f } of logs) {
      const fd = readFileSync(join(projectDir, f), 'utf8').slice(0, 64_000);
      const m = fd.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  } catch {
    // fall through
  }
  return null;
}

function readProject(projectsRoot: string, slug: string, knownCwd: string | null): MemoryProject {
  const dir = join(projectsRoot, slug, 'memory');
  const { index, memories } = readMemoryDir(dir);
  return {
    slug,
    cwd: knownCwd ?? resolveProjectCwd(join(projectsRoot, slug)),
    dir,
    index,
    memories,
  };
}

// ── Instruction files ───────────────────────────────────────────────

function readInstruction(
  path: string,
  label: string,
  scope: InstructionFile['scope']
): InstructionFile | null {
  if (!existsSync(path)) return null;
  try {
    return { label, scope, path, content: readFileSync(path, 'utf8').trim(), modified: mtime(path) };
  } catch {
    return null;
  }
}

function listInstructions(cwd: string, home: string): InstructionFile[] {
  const out: InstructionFile[] = [];
  const push = (f: InstructionFile | null) => f && out.push(f);
  push(readInstruction(join(home, '.claude', 'CLAUDE.md'), '~/.claude/CLAUDE.md', 'global'));
  push(readInstruction(join(cwd, 'CLAUDE.md'), 'CLAUDE.md', 'project'));
  push(readInstruction(join(cwd, '.claude', 'CLAUDE.md'), '.claude/CLAUDE.md', 'project'));
  push(readInstruction(join(cwd, 'CLAUDE.local.md'), 'CLAUDE.local.md', 'project'));
  push(readInstruction(join(cwd, 'AGENTS.md'), 'AGENTS.md', 'project'));
  const rulesDir = join(cwd, '.claude', 'rules');
  if (existsSync(rulesDir)) {
    try {
      for (const f of readdirSync(rulesDir).sort()) {
        if (f.endsWith('.md')) push(readInstruction(join(rulesDir, f), `.claude/rules/${f}`, 'project'));
      }
    } catch {
      // ignore
    }
  }
  return out;
}

// ── Report ──────────────────────────────────────────────────────────

export function memoriesReport(): MemoriesReport {
  const cwd = resolve(process.cwd());
  const home = homedir();
  const projectsRoot = join(home, '.claude', 'projects');
  const currentSlug = projectSlug(cwd);

  const current = existsSync(join(projectsRoot, currentSlug))
    ? readProject(projectsRoot, currentSlug, cwd)
    : null;

  const others: MemoryProject[] = [];
  try {
    for (const slug of readdirSync(projectsRoot).sort()) {
      if (slug === currentSlug) continue;
      const memDir = join(projectsRoot, slug, 'memory');
      if (!existsSync(memDir)) continue;
      const p = readProject(projectsRoot, slug, null);
      // Skip empty folders and the scratchpad projects Claude Code creates for temp dirs.
      if (p.memories.length === 0 && !p.index) continue;
      if (/scratchpad/.test(slug)) continue;
      others.push(p);
    }
  } catch {
    // no projects dir yet
  }
  others.sort((a, b) => b.memories.length - a.memories.length);

  return { cwd, current, instructions: listInstructions(cwd, home), others };
}
