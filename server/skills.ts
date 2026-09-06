/**
 * Skill discovery for the /skills Telegram command. Scans the on-disk skill
 * locations of the given engine and returns name + description pairs.
 *
 * Claude Code skills live in `.claude/skills/<name>/SKILL.md` (project and
 * personal dirs) plus installed plugins.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EngineId } from './engine.ts';

export type SkillInfo = {
  name: string;
  description: string;
  /** Where the skill was found: 'project' | 'personal' | 'plugin' | 'prompt' */
  source: string;
};

/** Pull `name:` and `description:` out of a SKILL.md YAML frontmatter block. */
function parseSkillMd(path: string, fallbackName: string): SkillInfo | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : '';
  const field = (key: string): string => {
    const fmatch = fm.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'));
    if (!fmatch) return '';
    return fmatch[1].trim().replace(/^["']|["']$/g, '');
  };
  return {
    name: field('name') || fallbackName,
    description: field('description'),
    source: '',
  };
}

/** List `<dir>/<skill>/SKILL.md` entries. */
function scanSkillDir(dir: string, source: string): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const skillMd = join(dir, entry, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const info = parseSkillMd(skillMd, entry);
    if (info) out.push({ ...info, source });
  }
  return out;
}

/** Bounded walk under ~/.claude/plugins looking for `skills/<name>/SKILL.md`. */
function scanPluginSkills(root: string, depth = 0): SkillInfo[] {
  if (depth > 5 || !existsSync(root)) return [];
  const out: SkillInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (entry === 'skills') {
      out.push(...scanSkillDir(full, 'plugin'));
    } else {
      out.push(...scanPluginSkills(full, depth + 1));
    }
  }
  return out;
}

export function listSkills(engine: EngineId): SkillInfo[] {
  const home = homedir();
  const seen = new Set<string>();
  const dedupe = (skills: SkillInfo[]): SkillInfo[] =>
    skills.filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });

  // Project skills shadow personal ones, which shadow plugin ones — scan in
  // that order and dedupe by name.
  return dedupe([
    ...scanSkillDir(join(process.cwd(), '.claude', 'skills'), 'project'),
    ...scanSkillDir(join(home, '.claude', 'skills'), 'personal'),
    ...scanPluginSkills(join(home, '.claude', 'plugins')),
  ]);
}
