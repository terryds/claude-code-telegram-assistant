import { resolve, extname } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import {
  getSetting,
  setSetting,
  deleteSetting,
  recentMessages,
  recentFeed,
  listBookmarks,
  getBookmark,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  listJobs,
  getJob,
  getJobByName,
  addJob,
  updateJob,
  deleteJob,
  logMessage,
  addPendingContext,
} from './db.ts';
import {
  startJobScheduler,
  syncJobs,
  runJobNow,
  nextRunAt,
  validateSchedule,
  isJobRunning,
} from './jobs.ts';
import { fetchBookmarkMeta } from './bookmark-meta.ts';
import {
  getBotInfo,
  getRecentChats,
  getTelegramConfig,
  sendTelegram,
  sendTelegramPlain,
  sendTelegramRich,
} from './telegram.ts';
import {
  ENGINE_IDS,
  ENGINE_LABELS,
  getEngineId,
  setEngineId,
  isEngineId,
  isAuthMethod,
  getAuthConfig,
  setAuthMethod,
  setApiKey,
  getLastAuthProbe,
  saveAuthProbe,
  clearAuthProbe,
} from './engine.ts';
import { getEngine } from './engines.ts';
import { getPersona, setPersona, isCustomPersona, DEFAULT_PERSONA } from './persona.ts';
import {
  startClaudeLogin,
  submitClaudeLoginCode,
  cancelClaudeLogin,
  claudeLoginStatus,
} from './claude-login.ts';
import { startCodexLogin, cancelCodexLogin, codexLoginState } from './codex-login.ts';
import { updateInfo, checkForUpdates, startUpdate } from './updater.ts';
import {
  startQrPairing,
  pollQrPairing,
  cancelQrPairing,
  clearQrPairings,
} from './qr-onboarding.ts';
import {
  startListener,
  isRelayEnabled,
  setRelayEnabled,
  setCaptureMode,
  getCapturedChatId,
  listGroupLinks,
  unlinkGroup,
  unlinkAllGroups,
  setGroupCaptureMode,
  getGroupCaptureMode,
  isGroupCapturing,
  clearAllSessions,
  stopAllRuns,
  applyBotCommands,
  skipBacklog,
} from './tg-listener.ts';
import { setDashboardPort } from './dashboard-url.ts';

// Default to 8000 (exe.dev's default port); fall back to 3000 if it's taken.
// An explicit PORT env var always wins and is used as-is (no fallback).
const PORT_CANDIDATES = process.env.PORT ? [Number(process.env.PORT)] : [8000, 3000];
const CLIENT_DIR = resolve('./dist/client');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

async function readBody<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

function isOnboarded(): boolean {
  return Boolean(getSetting('telegram_bot_token') && getSetting('telegram_chat_id'));
}

/** "myapp.example.com:3001" — the fallback bookmark title when a page has none. */
function hostLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

/** Whether an edited URL actually points somewhere new (ignoring scheme guessing). */
function normalizedUrlChanged(input: string, current: string): boolean {
  const strip = (s: string) => s.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return strip(input) !== strip(current);
}

/** Rough plain-text rendering of a Telegram-HTML message, for agent context. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** The slice of Bun.Server the API needs (the full type is generic across bun-types versions). */
type RequestIPServer = { requestIP(req: Request): { address: string } | null };

async function handleApi(req: Request, url: URL, server?: RequestIPServer): Promise<Response> {
  const p = url.pathname.replace(/^\/api/, '') || '/';
  const m = req.method;

  // Notification gateway for other services on this host: deliver to the
  // linked private chat, record in the dashboard feed, and queue a plain-text
  // summary the agent sees on its next turn. Loopback-only; contract in the
  // README ("Notification gateway").
  if (p === '/notify' && m === 'POST') {
    const ip = server?.requestIP(req)?.address;
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return err(401, 'notify is loopback-only');
    }
    const requiredToken = getSetting('notify_token');
    if (requiredToken && req.headers.get('x-notify-token') !== requiredToken) {
      return err(401, 'bad or missing X-Notify-Token header');
    }
    const body = await readBody<{
      text?: unknown;
      format?: unknown;
      source?: unknown;
      kind?: unknown;
      context?: unknown;
      no_context?: unknown;
      mode?: unknown;
    }>(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : null;
    if (!text) return err(400, 'text is required');
    if (!source) return err(400, 'source is required');
    if (body.mode !== undefined && body.mode !== 'deliver') {
      return err(400, 'unsupported mode — only "deliver" exists ("agent" is reserved)');
    }
    const format = body.format === undefined ? 'html' : body.format;
    if (format !== 'html' && format !== 'plain' && format !== 'md') {
      return err(400, 'format must be "html", "plain", or "md"');
    }
    if (!isOnboarded()) return err(503, 'relay not linked to a Telegram chat yet');

    const r =
      format === 'md'
        ? await sendTelegramRich(text)
        : format === 'plain'
          ? await sendTelegramPlain(text)
          : await sendTelegram(text);
    logMessage({
      direction: 'out',
      text: `[${source}${kind ? ` · ${kind}` : ''}] ${text}`,
      session_id: null,
      ok: r.ok,
      error: r.ok ? null : (r.error ?? null),
    });
    // Non-2xx on failure so callers with retry semantics (contentideas stamps
    // notified_at only after a successful send) retry on their next run.
    if (!r.ok) return err(502, r.error ?? 'Telegram send failed');
    if (body.no_context !== true) {
      const context =
        typeof body.context === 'string' && body.context.trim()
          ? body.context.trim()
          : stripHtml(text);
      if (context) addPendingContext({ source, kind, text: context });
    }
    return json({ ok: true });
  }

  if (p === '/status' && m === 'GET') {
    const cfg = getTelegramConfig();
    const bot = cfg.botToken
      ? await getBotInfo(cfg.botToken).then((r) => (r.ok ? r.bot : null))
      : null;
    return json({
      onboarded: isOnboarded(),
      bot_token_set: Boolean(cfg.botToken),
      chat_id: cfg.chatId,
      bot,
      relay_enabled: isRelayEnabled(),
      groups: listGroupLinks(),
      engine: getEngineId(),
      engines: ENGINE_IDS.map((id) => ({ id, label: ENGINE_LABELS[id] })),
      auth: { ...getAuthConfig(getEngineId()), last: getLastAuthProbe(getEngineId()) },
    });
  }

  // Verify a given engine's CLI is installed. `?engine=claude|codex`
  // (defaults to the active engine). `/claude-check` kept as a back-compat alias.
  if ((p === '/agent-check' || p === '/claude-check') && m === 'GET') {
    const q = url.searchParams.get('engine');
    const id = q && isEngineId(q) ? q : p === '/claude-check' ? 'claude' : getEngineId();
    const result = await getEngine(id).check();
    return json(result);
  }

  // Live-probe whether the given engine's CLI is authenticated. Slow (runs a
  // tiny real turn). `?engine=claude|codex` (defaults to the active engine).
  if (p === '/auth-check' && m === 'GET') {
    const q = url.searchParams.get('engine');
    const id = q && isEngineId(q) ? q : getEngineId();
    const result = await getEngine(id).checkAuth();
    // Cache the outcome so the dashboard can show auth state without
    // re-probing on every load.
    const rec = saveAuthProbe(id, result);
    return json({ ...result, checked_at: rec.checked_at });
  }

  // Read the persisted auth setup (method + whether a key is saved) and the
  // last cached probe result, without probing. Used by the dashboard to render
  // the current state cheaply.
  if (p === '/auth-config' && m === 'GET') {
    const q = url.searchParams.get('engine');
    const id = q && isEngineId(q) ? q : getEngineId();
    return json({ ...getAuthConfig(id), last: getLastAuthProbe(id) });
  }

  // Update auth setup: switch method and/or save (or clear) the API key.
  if (p === '/auth-config' && m === 'POST') {
    const body = await readBody<{ engine?: string; method?: string; apiKey?: string }>(req);
    const id = (body.engine || getEngineId()).trim();
    if (!isEngineId(id)) return err(400, 'engine must be "claude" or "codex"');
    if (body.method !== undefined) {
      if (!isAuthMethod(body.method)) {
        return err(400, 'method must be "subscription" or "apikey"');
      }
      setAuthMethod(id, body.method);
      clearAuthProbe(id); // setup changed — the cached probe no longer applies
    }
    // An explicit empty string clears the saved key; undefined leaves it alone.
    if (body.apiKey !== undefined) {
      setApiKey(id, body.apiKey);
      clearAuthProbe(id);
    }
    return json({ ok: true, ...getAuthConfig(id) });
  }

  // Claude subscription sign-in, driven from the dashboard (no terminal).
  // Start → returns the authorize URL; the user authorizes and pastes the code.
  if (p === '/auth/claude-login/start' && m === 'POST') {
    try {
      return json(await startClaudeLogin());
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e));
    }
  }

  if (p === '/auth/claude-login/code' && m === 'POST') {
    const body = await readBody<{ code?: string }>(req);
    const result = await submitClaudeLoginCode(body.code || '');
    if (!result.ok) return err(400, result.error || 'Sign-in failed.');
    return json({ ok: true });
  }

  // Poll the in-progress sign-in: { state: 'idle'|'awaiting'|'done'|'error' }.
  if (p === '/auth/claude-login/status' && m === 'GET') {
    return json(claudeLoginStatus());
  }

  // Codex subscription sign-in (device-authorization flow). Start → returns the
  // verification URL + one-time code; the user enters it in their browser and
  // the CLI polls to completion (no paste needed).
  if (p === '/auth/codex-login/start' && m === 'POST') {
    try {
      return json(await startCodexLogin());
    } catch (e) {
      return err(400, e instanceof Error ? e.message : String(e));
    }
  }

  if (p === '/auth/codex-login/status' && m === 'GET') {
    return json(codexLoginState());
  }

  if (p === '/auth/codex-login/cancel' && m === 'POST') {
    cancelCodexLogin();
    return json({ ok: true });
  }

  if (p === '/auth/claude-login/cancel' && m === 'POST') {
    cancelClaudeLogin();
    return json({ ok: true });
  }

  if (p === '/engine' && m === 'GET') {
    return json({ engine: getEngineId() });
  }

  if (p === '/engine' && m === 'POST') {
    const body = await readBody<{ engine?: string }>(req);
    const id = (body.engine || '').trim();
    if (!isEngineId(id)) return err(400, 'engine must be "claude" or "codex"');
    // Sessions don't carry across engines; stop in-flight runs and clear so
    // the next message is fresh.
    stopAllRuns();
    clearAllSessions();
    setEngineId(id);
    return json({ ok: true, engine: id });
  }

  if (p === '/persona' && m === 'GET') {
    return json({
      persona: getPersona(),
      custom: isCustomPersona(),
      default_persona: DEFAULT_PERSONA,
    });
  }

  if (p === '/persona' && m === 'POST') {
    const body = await readBody<{ persona?: string }>(req);
    // Persona is injected at session start, so stop in-flight runs and clear
    // sessions — the next message picks it up in a fresh conversation.
    stopAllRuns();
    clearAllSessions();
    setPersona(body.persona ?? '');
    return json({ ok: true, persona: getPersona(), custom: isCustomPersona() });
  }

  if (p === '/onboarding/save-token' && m === 'POST') {
    const body = await readBody<{ token?: string }>(req);
    const token = (body.token || '').trim();
    if (!token) return err(400, 'Token required');
    const r = await getBotInfo(token);
    if (!r.ok) return err(400, `Invalid token: ${r.error}`);
    setSetting('telegram_bot_token', token);
    // Reset any prior chat link so capture starts fresh, and drop the old
    // bot's getUpdates offset (meaningless — possibly harmful — for the new one).
    deleteSetting('telegram_chat_id');
    deleteSetting('telegram_update_offset');
    return json({ ok: true, bot: r.bot });
  }

  // QR onboarding (managed bots): mint a pairing at the setup service, show
  // the QR, poll until Telegram hands over the new bot's token. The poll
  // response never contains the token itself — only the getMe result.
  if (p === '/onboarding/qr/start' && m === 'POST') {
    const r = await startQrPairing();
    if (!r.ok) return err(502, r.error);
    return json(r.pairing);
  }

  const qrPoll = p.match(/^\/onboarding\/qr\/([A-Za-z0-9]+)$/);
  if (qrPoll && m === 'GET') {
    const r = await pollQrPairing(qrPoll[1]);
    if (!r) return err(404, 'Unknown pairing');
    return json(r);
  }

  const qrCancel = p.match(/^\/onboarding\/qr\/([A-Za-z0-9]+)\/cancel$/);
  if (qrCancel && m === 'POST') {
    cancelQrPairing(qrCancel[1]);
    return json({ ok: true });
  }

  if (p === '/onboarding/start-capture' && m === 'POST') {
    if (!getSetting('telegram_bot_token')) return err(400, 'Save a bot token first');
    await skipBacklog();
    setCaptureMode(true);
    return json({ ok: true });
  }

  if (p === '/onboarding/captured' && m === 'GET') {
    return json({ chat_id: getCapturedChatId() });
  }

  if (p === '/onboarding/cancel-capture' && m === 'POST') {
    setCaptureMode(false);
    return json({ ok: true });
  }

  // Group-topic links: same capture flow as onboarding, but for group chats
  // (optionally a forum topic inside one), added one at a time. Existing links
  // stay active while capturing; the client polls /group/status and treats
  // capturing flipping to false as "done".
  if (p === '/group/start-capture' && m === 'POST') {
    if (!getSetting('telegram_bot_token')) return err(400, 'Save a bot token first');
    const body = await readBody<{ mode?: string }>(req);
    // 'topic' waits for a message inside a forum topic; 'group' links the
    // whole group off any group message. Default: topic.
    const mode = body.mode === 'group' ? 'group' : 'topic';
    await skipBacklog();
    setGroupCaptureMode(mode);
    return json({ ok: true, mode });
  }

  if (p === '/group/status' && m === 'GET') {
    return json({
      capturing: isGroupCapturing(),
      mode: getGroupCaptureMode(),
      groups: listGroupLinks(),
    });
  }

  if (p === '/group/cancel-capture' && m === 'POST') {
    setGroupCaptureMode(null);
    return json({ ok: true });
  }

  if (p === '/group/unlink' && m === 'POST') {
    const body = await readBody<{ id?: number }>(req);
    if (typeof body.id !== 'number') return err(400, 'Link id required');
    if (!unlinkGroup(body.id)) return err(404, 'No such link');
    return json({ ok: true });
  }

  if (p === '/relay' && m === 'POST') {
    const body = await readBody<{ enabled?: boolean }>(req);
    const enabled = Boolean(body.enabled);
    if (enabled && !isOnboarded()) return err(400, 'Finish onboarding first');
    setRelayEnabled(enabled);
    if (enabled) {
      await skipBacklog();
      applyBotCommands().catch(() => {});
    }
    return json({ ok: true, enabled });
  }

  // Self-update: version info, remote check (git fetch), and launch of
  // bin/safe-update-relay (detached — it restarts this process via pm2).
  if (p === '/update/info' && m === 'GET') {
    return json(updateInfo());
  }

  if (p === '/update/check' && m === 'POST') {
    const r = checkForUpdates();
    if (!r.ok) return err(502, r.error);
    return json(r);
  }

  if (p === '/update/run' && m === 'POST') {
    const r = startUpdate();
    if (!r.ok) return err(409, r.error);
    return json({ ok: true });
  }

  // Bookmarks: quick links to other apps (often ones the agent deployed on
  // other ports of this host), shown at the top of the dashboard. Creating or
  // changing a URL fetches the page's title + favicon server-side.
  if (p === '/bookmarks' && m === 'GET') {
    return json({ bookmarks: listBookmarks() });
  }

  if (p === '/bookmarks' && m === 'POST') {
    const body = await readBody<{ url?: string; title?: string }>(req);
    const rawUrl = (body.url || '').trim();
    if (!rawUrl) return err(400, 'URL required');
    const meta = await fetchBookmarkMeta(rawUrl);
    const explicitTitle = (body.title || '').trim();
    const title = explicitTitle || meta.title || hostLabel(meta.url);
    const bookmark = addBookmark({ url: meta.url, title, favicon: meta.favicon });
    return json({ ok: true, bookmark });
  }

  const bmEdit = p.match(/^\/bookmarks\/(\d+)$/);
  if (bmEdit && m === 'POST') {
    const id = Number(bmEdit[1]);
    const existing = getBookmark(id);
    if (!existing) return err(404, 'No such bookmark');
    const body = await readBody<{ url?: string; title?: string }>(req);
    const rawUrl = (body.url ?? '').trim();
    const explicitTitle = (body.title ?? '').trim();

    if (rawUrl && normalizedUrlChanged(rawUrl, existing.url)) {
      // URL changed — refetch metadata for the new target.
      const meta = await fetchBookmarkMeta(rawUrl);
      const bookmark = updateBookmark(id, {
        url: meta.url,
        title: explicitTitle || meta.title || hostLabel(meta.url),
        favicon: meta.favicon,
      });
      return json({ ok: true, bookmark });
    }

    const bookmark = updateBookmark(id, explicitTitle ? { title: explicitTitle } : {});
    return json({ ok: true, bookmark });
  }

  if (bmEdit && m === 'DELETE') {
    if (!deleteBookmark(Number(bmEdit[1]))) return err(404, 'No such bookmark');
    return json({ ok: true });
  }

  const bmRefresh = p.match(/^\/bookmarks\/(\d+)\/refresh$/);
  if (bmRefresh && m === 'POST') {
    const id = Number(bmRefresh[1]);
    const existing = getBookmark(id);
    if (!existing) return err(404, 'No such bookmark');
    const meta = await fetchBookmarkMeta(existing.url);
    // Only overwrite fields the fetch actually produced — a temporarily-down
    // app shouldn't wipe the icon and title we already have.
    const bookmark = updateBookmark(id, {
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.favicon ? { favicon: meta.favicon } : {}),
    });
    return json({ ok: true, bookmark, reachable: Boolean(meta.title || meta.favicon) });
  }

  // Scheduled jobs: watcher scripts registered by the agent (via bin/job) or
  // the dashboard, run on a cron schedule by server/jobs.ts. Rows are the
  // source of truth — every mutation ends with syncJobs() to reconcile the
  // in-process Bun.cron registrations.
  if (p === '/jobs' && m === 'GET') {
    const jobs = listJobs().map((j) => ({
      ...j,
      next_run_at: j.enabled ? nextRunAt(j.schedule) : null,
      running: isJobRunning(j.id),
    }));
    return json({ jobs });
  }

  if (p === '/jobs' && m === 'POST') {
    const body = await readBody<{
      name?: string;
      description?: string;
      schedule?: string;
      script_path?: string;
    }>(req);
    const name = (body.name || '').trim();
    const schedule = (body.schedule || '').trim();
    const scriptPath = resolve((body.script_path || '').trim());
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
      return err(400, 'name must be a short slug (letters, digits, - and _)');
    }
    if (!schedule) return err(400, 'schedule (cron expression) required');
    const bad = validateSchedule(schedule);
    if (bad) return err(400, `invalid schedule: ${bad}`);
    if (!body.script_path || !existsSync(scriptPath)) {
      return err(400, `script not found: ${scriptPath}`);
    }
    // Upsert by name so re-registering a watcher updates it in place.
    const existing = getJobByName(name);
    const job = existing
      ? updateJob(existing.id, {
          // Empty description on a re-register keeps the existing one.
          description: (body.description || '').trim() || existing.description,
          schedule,
          script_path: scriptPath,
        })
      : addJob({ name, description: (body.description || '').trim(), schedule, script_path: scriptPath });
    syncJobs();
    return json({ ok: true, job: { ...job!, next_run_at: nextRunAt(job!.schedule) } });
  }

  const jobEdit = p.match(/^\/jobs\/(\d+)$/);
  if (jobEdit && m === 'POST') {
    const id = Number(jobEdit[1]);
    if (!getJob(id)) return err(404, 'No such job');
    const body = await readBody<{
      description?: string;
      schedule?: string;
      script_path?: string;
      enabled?: boolean;
    }>(req);
    if (body.schedule !== undefined) {
      const bad = validateSchedule(body.schedule.trim());
      if (bad) return err(400, `invalid schedule: ${bad}`);
    }
    if (body.script_path !== undefined && !existsSync(resolve(body.script_path))) {
      return err(400, `script not found: ${resolve(body.script_path)}`);
    }
    const job = updateJob(id, {
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.schedule !== undefined ? { schedule: body.schedule.trim() } : {}),
      ...(body.script_path !== undefined ? { script_path: resolve(body.script_path) } : {}),
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    });
    syncJobs();
    return json({ ok: true, job });
  }

  if (jobEdit && m === 'DELETE') {
    if (!deleteJob(Number(jobEdit[1]))) return err(404, 'No such job');
    syncJobs();
    return json({ ok: true });
  }

  const jobRun = p.match(/^\/jobs\/(\d+)\/run$/);
  if (jobRun && m === 'POST') {
    const r = await runJobNow(Number(jobRun[1]));
    if ('error' in r) return err(409, r.error);
    return json({ ok: true, ...r });
  }

  if (p === '/reset-session' && m === 'POST') {
    stopAllRuns();
    clearAllSessions();
    return json({ ok: true });
  }

  if (p === '/messages' && m === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    return json({ messages: recentMessages(limit) });
  }

  if (p === '/feed' && m === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 300), 1000);
    return json({ events: recentFeed(limit) });
  }

  if (p === '/chats' && m === 'GET') {
    const token = getSetting('telegram_bot_token');
    if (!token) return err(400, 'No bot token');
    const r = await getRecentChats(token);
    if (!r.ok) return err(400, r.error);
    return json({ chats: r.chats });
  }

  if (p === '/reset' && m === 'POST') {
    stopAllRuns();
    setRelayEnabled(false);
    deleteSetting('telegram_bot_token');
    deleteSetting('telegram_chat_id');
    clearAllSessions();
    deleteSetting('captured_chat_id');
    deleteSetting('capture_chat_id');
    clearQrPairings();
    unlinkAllGroups();
    return json({ ok: true });
  }

  return err(404, 'Not found');
}

function serveStatic(url: URL): Response {
  if (!existsSync(CLIENT_DIR)) {
    return new Response(
      [
        'Client not built yet.',
        '',
        'Run `bun run build` to build the client, or `bun run dev` for hot-reload development.',
        '',
        `Looked in: ${CLIENT_DIR}`,
      ].join('\n'),
      { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }
  const safePath = url.pathname.replace(/\.\./g, '');
  let filePath = resolve(CLIENT_DIR, '.' + safePath);
  if (!filePath.startsWith(CLIENT_DIR)) return new Response('Forbidden', { status: 403 });

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    stat = null;
  }

  if (!stat || stat.isDirectory()) {
    filePath = resolve(CLIENT_DIR, 'index.html');
    try {
      stat = statSync(filePath);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }

  const ext = extname(filePath).toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  const data = readFileSync(filePath);
  return new Response(data, { headers: { 'Content-Type': ct } });
}

startListener();
startJobScheduler();

// Refresh the Telegram command menu on boot so deploys pick up command changes.
// (Otherwise setMyCommands only runs when the relay is toggled on, leaving the
// menu stale across restarts.)
if (isRelayEnabled()) applyBotCommands().catch(() => {});

const fetchHandler = async (req: Request, server?: RequestIPServer) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api')) {
    try {
      return await handleApi(req, url, server);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[api] error:', msg);
      return err(500, msg);
    }
  }
  return serveStatic(url);
};

function serve() {
  for (const port of PORT_CANDIDATES) {
    try {
      return Bun.serve({ port, fetch: fetchHandler });
    } catch (e) {
      const isInUse = e instanceof Error && /EADDRINUSE|in use|address already/i.test(e.message);
      const isLast = port === PORT_CANDIDATES[PORT_CANDIDATES.length - 1];
      if (!isInUse || isLast) throw e;
      console.warn(`port ${port} is in use, trying ${PORT_CANDIDATES[PORT_CANDIDATES.indexOf(port) + 1]}…`);
    }
  }
  throw new Error('no port available');
}

const server = serve();
setDashboardPort(server.port);

console.log(`claude-code-telegram-assistant listening on http://localhost:${server.port}`);
