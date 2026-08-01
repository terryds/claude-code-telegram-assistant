import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClaudeStep } from './claude-stream.ts';

const DATA_DIR = resolve('./data');
mkdirSync(DATA_DIR, { recursive: true });

const dbPath = resolve(DATA_DIR, 'app.db');
export const db = new Database(dbPath, { create: true });
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA foreign_keys = ON');

db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS message_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    direction TEXT NOT NULL,
    text TEXT NOT NULL,
    session_id TEXT,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT
  )
`);

db.run('CREATE INDEX IF NOT EXISTS idx_message_log_created_at ON message_log(created_at DESC)');

// Intermediate steps streamed from Claude during a run (thinking, tool calls,
// tool results) — the same events forwarded live to Telegram. Final text
// replies are NOT stored here; they live in message_log as `out` rows.
db.run(`
  CREATE TABLE IF NOT EXISTS step_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    session_id TEXT,
    kind TEXT NOT NULL,
    tool_name TEXT,
    tool_input TEXT,
    result_text TEXT
  )
`);

db.run('CREATE INDEX IF NOT EXISTS idx_step_log_created_at ON step_log(created_at DESC)');

// Linked group chats/topics the relay answers in (besides the private chat).
// topic_id NULL = the whole group; otherwise one forum topic.
db.run(`
  CREATE TABLE IF NOT EXISTS group_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    topic_id TEXT,
    chat_title TEXT,
    topic_name TEXT,
    created_at INTEGER NOT NULL
  )
`);

// User-managed links to other apps running on this host (or anywhere) —
// shown at the top of the dashboard. `favicon` is a data: URI fetched
// server-side so icons render even when the target app is temporarily down.
db.run(`
  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    favicon TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// Scheduled jobs: watcher scripts the agent writes (usually under
// data/jobs/<name>/) that the in-process scheduler (server/jobs.ts) runs on a
// cron schedule. A run's non-empty stdout is sent to the linked Telegram chat;
// empty stdout means "nothing to report". `schedule` is a 5-field cron
// expression interpreted in UTC (Bun.cron semantics).
db.run(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL,
    script_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_exit_code INTEGER,
    last_output TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0
  )
`);

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export type Bookmark = {
  id: number;
  url: string;
  title: string;
  favicon: string | null;
  created_at: number;
  updated_at: number;
};

export function listBookmarks(): Bookmark[] {
  return db
    .prepare('SELECT * FROM bookmarks ORDER BY created_at ASC, id ASC')
    .all() as Bookmark[];
}

export function getBookmark(id: number): Bookmark | null {
  return (db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as Bookmark | undefined) ?? null;
}

export function addBookmark(entry: { url: string; title: string; favicon?: string | null }): Bookmark {
  const now = Date.now();
  const r = db
    .prepare(
      'INSERT INTO bookmarks (url, title, favicon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(entry.url, entry.title, entry.favicon ?? null, now, now);
  return getBookmark(Number(r.lastInsertRowid))!;
}

export function updateBookmark(
  id: number,
  patch: { url?: string; title?: string; favicon?: string | null }
): Bookmark | null {
  const existing = getBookmark(id);
  if (!existing) return null;
  db.prepare('UPDATE bookmarks SET url = ?, title = ?, favicon = ?, updated_at = ? WHERE id = ?').run(
    patch.url ?? existing.url,
    patch.title ?? existing.title,
    patch.favicon === undefined ? existing.favicon : patch.favicon,
    Date.now(),
    id
  );
  return getBookmark(id);
}

export function deleteBookmark(id: number): boolean {
  return db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id).changes > 0;
}

export type Job = {
  id: number;
  name: string;
  description: string;
  schedule: string;
  script_path: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_exit_code: number | null;
  last_output: string | null;
  consecutive_failures: number;
};

export function listJobs(): Job[] {
  return db.prepare('SELECT * FROM jobs ORDER BY created_at ASC, id ASC').all() as Job[];
}

export function getJob(id: number): Job | null {
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined) ?? null;
}

export function getJobByName(name: string): Job | null {
  return (db.prepare('SELECT * FROM jobs WHERE name = ?').get(name) as Job | undefined) ?? null;
}

export function addJob(entry: {
  name: string;
  description: string;
  schedule: string;
  script_path: string;
}): Job {
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO jobs (name, description, schedule, script_path, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
    .run(entry.name, entry.description, entry.schedule, entry.script_path, now, now);
  return getJob(Number(r.lastInsertRowid))!;
}

export function updateJob(
  id: number,
  patch: { description?: string; schedule?: string; script_path?: string; enabled?: boolean }
): Job | null {
  const existing = getJob(id);
  if (!existing) return null;
  db.prepare(
    'UPDATE jobs SET description = ?, schedule = ?, script_path = ?, enabled = ?, updated_at = ? WHERE id = ?'
  ).run(
    patch.description ?? existing.description,
    patch.schedule ?? existing.schedule,
    patch.script_path ?? existing.script_path,
    patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
    Date.now(),
    id
  );
  return getJob(id);
}

export function deleteJob(id: number): boolean {
  return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
}

/** Persist one run's outcome and maintain the consecutive-failure counter. */
export function recordJobRun(
  id: number,
  result: { exit_code: number; output: string }
): Job | null {
  const existing = getJob(id);
  if (!existing) return null;
  const failures = result.exit_code === 0 ? 0 : existing.consecutive_failures + 1;
  db.prepare(
    `UPDATE jobs SET last_run_at = ?, last_exit_code = ?, last_output = ?, consecutive_failures = ?
     WHERE id = ?`
  ).run(Date.now(), result.exit_code, result.output, failures, id);
  return getJob(id);
}

export type MessageLogEntry = {
  id: number;
  created_at: number;
  direction: 'in' | 'out';
  text: string;
  session_id: string | null;
  ok: boolean;
  error: string | null;
};

export function logMessage(entry: {
  direction: 'in' | 'out';
  text: string;
  session_id: string | null;
  ok?: boolean;
  error?: string | null;
}): void {
  db.prepare(
    `INSERT INTO message_log (created_at, direction, text, session_id, ok, error)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    entry.direction,
    entry.text,
    entry.session_id,
    entry.ok === false ? 0 : 1,
    entry.error ?? null
  );
}

/** Persist one streamed step. `text` steps are skipped (the final reply is
 *  stored as a message_log `out` row, so storing it here would duplicate it). */
export function logStep(step: ClaudeStep, sessionId: string | null): void {
  if (step.kind === 'text') return;
  db.prepare(
    `INSERT INTO step_log (created_at, session_id, kind, tool_name, tool_input, result_text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    sessionId,
    step.kind,
    step.toolName ?? null,
    step.toolInput ?? null,
    step.resultText ?? null
  );
}

export type FeedEvent =
  | {
      etype: 'message';
      id: number;
      created_at: number;
      direction: 'in' | 'out';
      text: string;
      session_id: string | null;
      ok: boolean;
      error: string | null;
    }
  | {
      etype: 'step';
      id: number;
      created_at: number;
      session_id: string | null;
      kind: 'thinking' | 'tool_use' | 'tool_result';
      tool_name: string | null;
      tool_input: string | null;
      result_text: string | null;
    };

/**
 * Merged, time-ordered feed of messages and steps — the dashboard equivalent of
 * the live Telegram stream. Returns the most recent `limit` events newest-first.
 */
export function recentFeed(limit = 300): FeedEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT 'message' AS etype, id, created_at, direction, text, session_id, ok,
                NULL AS kind, NULL AS tool_name, NULL AS tool_input, NULL AS result_text, error
         FROM message_log
         UNION ALL
         SELECT 'step' AS etype, id, created_at, NULL, NULL, session_id, NULL,
                kind, tool_name, tool_input, result_text, NULL
         FROM step_log
       )
       ORDER BY created_at DESC, etype DESC, id DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    etype: 'message' | 'step';
    id: number;
    created_at: number;
    direction: 'in' | 'out' | null;
    text: string | null;
    session_id: string | null;
    ok: number | null;
    kind: 'thinking' | 'tool_use' | 'tool_result' | null;
    tool_name: string | null;
    tool_input: string | null;
    result_text: string | null;
    error: string | null;
  }>;

  // Already newest-first from the query.
  return rows.map((r): FeedEvent =>
    r.etype === 'message'
      ? {
          etype: 'message',
          id: r.id,
          created_at: r.created_at,
          direction: r.direction as 'in' | 'out',
          text: r.text ?? '',
          session_id: r.session_id,
          ok: r.ok === 1,
          error: r.error,
        }
      : {
          etype: 'step',
          id: r.id,
          created_at: r.created_at,
          session_id: r.session_id,
          kind: r.kind as 'thinking' | 'tool_use' | 'tool_result',
          tool_name: r.tool_name,
          tool_input: r.tool_input,
          result_text: r.result_text,
        }
  );
}

export function recentMessages(limit = 50): MessageLogEntry[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, direction, text, session_id, ok, error
       FROM message_log
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: number;
    created_at: number;
    direction: 'in' | 'out';
    text: string;
    session_id: string | null;
    ok: number;
    error: string | null;
  }>;
  return rows.map((r) => ({ ...r, ok: r.ok === 1 }));
}
