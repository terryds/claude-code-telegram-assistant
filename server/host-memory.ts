// Host memory guard.
//
// Why: the relay once looked dead for a whole afternoon because six stale
// PR-preview servers the agent had started under pm2 in earlier turns were
// still running and had eaten most of the VM's RAM. `claude -p` spawns and
// the dashboard's HTTP calls starved, and from Telegram that is indistinguishable
// from a crash. Nothing in the relay knew about memory at all.
//
// This module makes the failure mode visible: before each run the listener
// asks `checkHostMemory()`; when the host is low it posts a warning naming the
// biggest processes and prepends the same facts to the prompt, so the agent
// knows to clean up (`bin/preview gc`, `pm2 delete …`) instead of guessing why
// its tools are slow. The run itself is never blocked — the user's "why are
// you dead?" message has to get through.

import { platform, totalmem } from 'node:os';

/** Available memory below this many MiB counts as "low". Env: LOW_MEMORY_MB. */
export const LOW_MEMORY_MB = Number(Bun.env.LOW_MEMORY_MB || '512');

/** Don't repeat the Telegram warning to one chat more often than this. */
const WARN_COOLDOWN_MS = 15 * 60 * 1000;

/** How long to wait for `pm2 jlist` / `ps` before giving up on the process list. */
const PROC_LIST_TIMEOUT_MS = 5_000;

export type MemoryReading = {
  /** Memory a new process could actually use (Linux MemAvailable), in bytes. */
  availableBytes: number;
  totalBytes: number;
};

export type HeavyProcess = {
  /** pm2 process name when known, else the command line. */
  name: string;
  pid: number;
  rssBytes: number;
  /** Seconds since the process started, when known. */
  uptimeSec: number | null;
  /** True when the entry came from pm2 (so `pm2 delete <name>` applies). */
  pm2: boolean;
};

export type MemoryCheck = {
  low: boolean;
  reading: MemoryReading | null;
  thresholdMb: number;
  /** Heaviest processes by RSS, only collected when memory is low. */
  heavy: HeavyProcess[];
};

const MIB = 1024 * 1024;

/**
 * Parse Linux /proc/meminfo. MemAvailable (kernel ≥ 3.14) is what a new
 * process can actually get; MemFree alone undercounts by the page cache.
 */
export function parseMeminfo(text: string): MemoryReading | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = kb('MemTotal');
  if (total === null) return null;
  let available = kb('MemAvailable');
  if (available === null) {
    // Pre-3.14 kernels: approximate with free + reclaimable cache.
    const free = kb('MemFree') ?? 0;
    const cached = kb('Cached') ?? 0;
    const reclaimable = kb('SReclaimable') ?? 0;
    available = free + cached + reclaimable;
  }
  return { availableBytes: available * 1024, totalBytes: total * 1024 };
}

/**
 * macOS `vm_stat`: free + inactive + speculative pages are what a new process
 * can claim. (os.freemem() reports only "free", which is tiny on any Mac that
 * has been up for an hour — it would flag every dev box as starved.)
 */
export function parseVmStat(text: string, totalBytes: number): MemoryReading | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 0);
  if (!pageSize) return null;
  let pages = 0;
  for (const key of ['Pages free', 'Pages inactive', 'Pages speculative']) {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
    if (m) pages += Number(m[1]);
  }
  return { availableBytes: pages * pageSize, totalBytes };
}

export async function readMemory(): Promise<MemoryReading | null> {
  try {
    const f = Bun.file('/proc/meminfo');
    if (await f.exists()) return parseMeminfo(await f.text());
  } catch {}
  if (platform() === 'darwin') {
    const out = await runCapture(['vm_stat'], PROC_LIST_TIMEOUT_MS);
    return out ? parseVmStat(out, totalmem()) : null;
  }
  // Unknown platform: no reading → the guard stays quiet rather than guessing.
  return null;
}

export function isLowMemory(reading: MemoryReading | null, thresholdMb = LOW_MEMORY_MB): boolean {
  if (!reading || thresholdMb <= 0) return false;
  return reading.availableBytes < thresholdMb * MIB;
}

async function runCapture(cmd: string[], timeoutMs: number): Promise<string | null> {
  const spawn = () => Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch {
    return null;
  }
  const timer = setTimeout(() => {
    try { proc.kill(9); } catch {}
  }, timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type Pm2Entry = {
  name?: string;
  pid?: number;
  monit?: { memory?: number };
  pm2_env?: { pm_uptime?: number; status?: string };
};

/** pm2-managed processes by RSS, heaviest first. Empty when pm2 is absent/slow. */
export async function listPm2Processes(): Promise<HeavyProcess[]> {
  const out = await runCapture(['pm2', 'jlist'], PROC_LIST_TIMEOUT_MS);
  if (!out) return [];
  let list: Pm2Entry[];
  try {
    // pm2 may print a banner line before the JSON on first use.
    list = JSON.parse(out.slice(out.indexOf('['))) as Pm2Entry[];
  } catch {
    return [];
  }
  const now = Date.now();
  return list
    .filter((e) => e.pm2_env?.status === 'online' && typeof e.pid === 'number')
    .map((e) => ({
      name: e.name ?? `pid ${e.pid}`,
      pid: e.pid!,
      rssBytes: e.monit?.memory ?? 0,
      uptimeSec: e.pm2_env?.pm_uptime ? Math.max(0, Math.round((now - e.pm2_env.pm_uptime) / 1000)) : null,
      pm2: true,
    }))
    .sort((a, b) => b.rssBytes - a.rssBytes);
}

/**
 * Parse `ps -eo pid,rss,etimes,args` (Linux; rss in KiB, elapsed seconds) or
 * `ps -eo pid,rss,args` (macOS has no `etimes`), heaviest first.
 */
export function parsePs(text: string): HeavyProcess[] {
  const lines = text.split('\n');
  const withElapsed = /ELAPSED/.test(lines[0] ?? '');
  const rows: HeavyProcess[] = [];
  for (const line of lines.slice(1)) {
    const m = withElapsed
      ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      : /^\s*(\d+)\s+(\d+)\s+()(.*)$/.exec(line);
    if (!m) continue;
    rows.push({
      name: m[4].trim(),
      pid: Number(m[1]),
      rssBytes: Number(m[2]) * 1024,
      uptimeSec: withElapsed ? Number(m[3]) : null,
      pm2: false,
    });
  }
  return rows.sort((a, b) => b.rssBytes - a.rssBytes);
}

async function listPsProcesses(): Promise<HeavyProcess[]> {
  const cols = platform() === 'linux' ? 'pid,rss,etimes,args' : 'pid,rss,args';
  const out = await runCapture(['ps', '-eo', cols], PROC_LIST_TIMEOUT_MS);
  return out ? parsePs(out) : [];
}

/**
 * Read memory and, when it's low, the heaviest processes. pm2 names are the
 * actionable ones (`pm2 delete <name>`), so prefer them; fall back to `ps`
 * when pm2 is missing or too slow to answer (likely, when the box is starved).
 */
export async function checkHostMemory(limit = 6): Promise<MemoryCheck> {
  const reading = await readMemory();
  const low = isLowMemory(reading);
  let heavy: HeavyProcess[] = [];
  if (low) {
    heavy = await listPm2Processes();
    if (heavy.length === 0) heavy = await listPsProcesses();
    heavy = heavy.slice(0, limit);
  }
  return { low, reading, thresholdMb: LOW_MEMORY_MB, heavy };
}

const fmtMb = (bytes: number) => `${Math.round(bytes / MIB)} MB`;

function fmtUptime(sec: number | null): string {
  if (sec === null) return '';
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function describeHeavy(heavy: HeavyProcess[]): string[] {
  return heavy.map((p) => {
    const up = fmtUptime(p.uptimeSec);
    const label = p.pm2 ? `\`${p.name}\` (pm2)` : `\`${p.name.slice(0, 60)}\` (pid ${p.pid})`;
    return `${label} — ${fmtMb(p.rssBytes)}${up ? `, up ${up}` : ''}`;
  });
}

/** Telegram warning (GitHub-Flavored Markdown, for sendTelegramRich) for a low-memory check. */
export function formatLowMemoryWarning(check: MemoryCheck): string {
  const r = check.reading!;
  const head =
    `⚠️ **Host is low on memory** — ${fmtMb(r.availableBytes)} available of ` +
    `${fmtMb(r.totalBytes)} (threshold ${check.thresholdMb} MB). Runs may be slow or ` +
    'fail until something is stopped.';
  if (check.heavy.length === 0) return head;
  return `${head}\nHeaviest processes:\n${describeHeavy(check.heavy).map((l) => `• ${l}`).join('\n')}`;
}

/** Plain-text preamble so the agent sees the same facts the user just did. */
export function formatLowMemoryContext(check: MemoryCheck): string {
  const r = check.reading!;
  const lines = describeHeavy(check.heavy).map((l) => `  - ${l.replace(/`/g, '')}`);
  return (
    `(Host memory warning: only ${fmtMb(r.availableBytes)} of ${fmtMb(r.totalBytes)} RAM is ` +
    `available (threshold ${check.thresholdMb} MB). Child processes may be slow or get OOM-killed. ` +
    'Before starting anything new, stop stale processes — `bin/preview list` / `bin/preview gc` ' +
    'for previews, `pm2 ls` for the rest — and tell the user what you stopped.' +
    (lines.length ? `\nHeaviest processes right now:\n${lines.join('\n')}` : '') +
    ')'
  );
}

const lastWarned = new Map<string, number>();

/** True at most once per cooldown window per chat (key: chat id, or chat:thread for a topic). */
export function shouldWarnChat(chatKey: string, now = Date.now()): boolean {
  const last = lastWarned.get(chatKey) ?? 0;
  if (now - last < WARN_COOLDOWN_MS) return false;
  lastWarned.set(chatKey, now);
  return true;
}
