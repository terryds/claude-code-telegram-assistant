/**
 * Read-only inventory of what the host's Claude Code can do, for the
 * dashboard's Capabilities page:
 *
 *  - MCP servers: `claude mcp list` (health-checks every server, so it takes a
 *    few seconds — the last result is cached in settings and refreshed on
 *    demand).
 *  - Plugins: `~/.claude/plugins/installed_plugins.json` plus the
 *    `enabledPlugins` map in `~/.claude/settings.json`.
 *  - Skills: reuse the `/skills` scanner in skills.ts.
 *
 * Everything runs from the relay's cwd, which is also where `claude -p` runs,
 * so project-scoped `.mcp.json` / `.claude/skills` show up as Claude sees them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSetting, setSetting } from './db.ts';

// ── MCP servers ─────────────────────────────────────────────────────

export type McpStatus = 'connected' | 'needs_auth' | 'failed' | 'pending' | 'unknown';

export type McpServer = {
  name: string;
  /** URL for http/sse servers, the command line for stdio ones. */
  target: string;
  /** e.g. "HTTP", "SSE", "stdio" — only when the CLI printed it. */
  transport: string | null;
  status: McpStatus;
  /** The CLI's own status text, e.g. "Needs authentication". */
  statusText: string;
};

export type McpSnapshot = {
  servers: McpServer[];
  checked_at: number;
  /** Set when the CLI itself failed (not when a server is unhealthy). */
  error?: string;
};

const MCP_CACHE_KEY = 'capabilities_mcp';
const MCP_TIMEOUT_MS = 60_000;

function classify(statusText: string): McpStatus {
  const s = statusText.toLowerCase();
  if (s.includes('connected')) return 'connected';
  if (s.includes('auth')) return 'needs_auth';
  if (s.includes('pending')) return 'pending';
  if (s.includes('fail') || s.includes('error') || s.includes('disconnected')) return 'failed';
  return 'unknown';
}

/**
 * Parse `claude mcp list` output. Each server is one line:
 *
 *   <name>: <url-or-command> [(TRANSPORT)] - <symbol> <status text>
 *
 * Names can themselves contain colons (`plugin:posthog:posthog`) but never
 * ": " (colon-space), so split on the first ": ". The status is after the
 * last " - " (URLs don't contain that).
 */
export function parseMcpList(output: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const raw of output.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!line || /^checking mcp server health/i.test(line) || /^no mcp servers/i.test(line)) {
      continue;
    }
    const nameEnd = line.indexOf(': ');
    if (nameEnd <= 0) continue;
    const name = line.slice(0, nameEnd);
    const rest = line.slice(nameEnd + 2);
    const sep = rest.lastIndexOf(' - ');
    if (sep < 0) continue;
    let target = rest.slice(0, sep).trim();
    // Strip the leading status glyph (✔ / ✘ / ! / ⏸ …) — keep the words.
    const statusText = rest
      .slice(sep + 3)
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .trim();
    let transport: string | null = null;
    const tm = target.match(/\s\(([A-Za-z]+)\)$/);
    if (tm) {
      transport = tm[1];
      target = target.slice(0, tm.index).trim();
    } else if (/^https?:\/\//.test(target)) {
      transport = 'HTTP'; // the CLI omits it for plain HTTP entries
    } else {
      transport = 'stdio';
    }
    servers.push({ name, target, transport, status: classify(statusText), statusText });
  }
  return servers;
}

export function getCachedMcp(): McpSnapshot | null {
  const raw = getSetting(MCP_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as McpSnapshot;
  } catch {
    return null;
  }
}

/** Run `claude mcp list`, cache and return the result. */
export async function refreshMcp(): Promise<McpSnapshot> {
  let snap: McpSnapshot;
  try {
    const proc = Bun.spawn(['claude', 'mcp', 'list'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    });
    const timer = setTimeout(() => proc.kill(), MCP_TIMEOUT_MS);
    const [out, errOut, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const servers = parseMcpList(out);
    snap = { servers, checked_at: Date.now() };
    if (code !== 0 && servers.length === 0) {
      snap.error = errOut.trim() || out.trim() || `claude mcp list exited ${code}`;
    }
  } catch (e) {
    snap = {
      servers: [],
      checked_at: Date.now(),
      error: `Couldn't run claude mcp list: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  setSetting(MCP_CACHE_KEY, JSON.stringify(snap));
  return snap;
}

// ── Required skills ─────────────────────────────────────────────────

/**
 * Skills the relay needs the agent to have. Mirrors REQUIRED_SKILLS in
 * bin/_deps.sh (bin/install installs them). pty-oauth-login is what lets the
 * agent finish OAuth sign-ins for MCP servers from a Telegram chat.
 */
export const REQUIRED_SKILLS = ['pty-oauth-login'] as const;

export type RequiredSkill = { name: string; installed: boolean };

export function checkRequiredSkills(): RequiredSkill[] {
  const home = homedir();
  return REQUIRED_SKILLS.map((name) => ({
    name,
    installed: existsSync(join(home, '.claude', 'skills', name, 'SKILL.md')),
  }));
}

// ── Plugins ─────────────────────────────────────────────────────────

export type PluginInfo = {
  /** `name@marketplace` as Claude Code identifies it. */
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  enabled: boolean;
  installedAt: string | null;
  lastUpdated: string | null;
  /** Short description from the plugin's manifest, when present. */
  description: string | null;
  /** Component counts derived from the install directory. */
  skills: number;
  agents: number;
  commands: number;
  hasMcp: boolean;
  hasHooks: boolean;
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function countDirs(path: string): number {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

function countFiles(path: string, ext: string): number {
  try {
    return readdirSync(path).filter((f) => f.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

export function listPlugins(): PluginInfo[] {
  const home = homedir();
  const installed = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json')) as {
    plugins?: Record<string, Array<Record<string, string>>>;
  } | null;
  const settings = readJson(join(home, '.claude', 'settings.json')) as {
    enabledPlugins?: Record<string, boolean>;
  } | null;
  const enabled = settings?.enabledPlugins ?? {};

  const out: PluginInfo[] = [];
  for (const [id, installs] of Object.entries(installed?.plugins ?? {})) {
    const inst = installs?.[0];
    if (!inst) continue;
    const at = id.indexOf('@');
    const name = at > 0 ? id.slice(0, at) : id;
    const marketplace = at > 0 ? id.slice(at + 1) : '';
    const dir = inst.installPath || '';
    const manifest = dir
      ? ((readJson(join(dir, '.claude-plugin', 'plugin.json')) ??
          readJson(join(dir, 'plugin.json'))) as { description?: string } | null)
      : null;
    out.push({
      id,
      name,
      marketplace,
      version: inst.version || '',
      scope: inst.scope || 'user',
      // Absent from the map means enabled (Claude Code's default).
      enabled: enabled[id] !== false,
      installedAt: inst.installedAt || null,
      lastUpdated: inst.lastUpdated || null,
      description: manifest?.description?.trim() || null,
      skills: dir ? countDirs(join(dir, 'skills')) : 0,
      agents: dir ? countFiles(join(dir, 'agents'), '.md') : 0,
      commands: dir ? countFiles(join(dir, 'commands'), '.md') : 0,
      hasMcp: dir ? existsSync(join(dir, 'mcp.json')) || existsSync(join(dir, '.mcp.json')) : false,
      hasHooks: dir ? existsSync(join(dir, 'hooks')) : false,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
