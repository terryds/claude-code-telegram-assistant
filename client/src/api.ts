async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && String((body as any).error)) ||
      `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export type BotInfo = { id: number; username: string; first_name: string };

export type EngineId = 'claude' | 'codex';
export type EngineInfo = { id: EngineId; label: string };

export type AuthMethod = 'subscription' | 'apikey';
export type AuthProbe = {
  authed: boolean;
  method: AuthMethod;
  error?: string;
  checked_at: number;
};
export type AuthConfig = { method: AuthMethod; hasKey: boolean; last?: AuthProbe | null };
export type EngineAuth = {
  authed: boolean;
  method: AuthMethod;
  hasKey: boolean;
  error?: string;
  checked_at?: number;
};

export type GroupCaptureMode = 'topic' | 'group';

export type GroupLink = {
  id: number;
  chat_id: string;
  topic_id: string | null; // null = the whole group
  chat_title: string | null;
  topic_name: string | null;
};

export type Status = {
  onboarded: boolean;
  bot_token_set: boolean;
  chat_id: string | null;
  bot: BotInfo | null;
  relay_enabled: boolean;
  groups: GroupLink[];
  engine: EngineId;
  engines: EngineInfo[];
  auth: AuthConfig;
};

export type QrPairing = {
  pairing_id: string;
  suggested_username: string;
  deep_link: string;
  qr_payload: string;
  expires_at: string;
};

export type QrPollResult =
  | { status: 'waiting'; expires_at: string }
  | { status: 'ready'; bot: BotInfo; chat_id: string | null }
  | { status: 'expired' }
  | { status: 'claimed' }
  | { status: 'error'; error: string };

export type CommitInfo = { sha: string; subject: string; date?: string };

export type UpdateState = {
  phase: 'running' | 'failed' | 'success';
  step?: string;
  detail?: string;
  old?: string;
  new?: string;
  ts: number;
};

export type UpdateInfo = {
  current: CommitInfo | null;
  managed: boolean;
  running: boolean;
  state: UpdateState | null;
};

export type UpdateCheck = { ok: true; behind: number; commits: CommitInfo[] };

export type AgentCheck = {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
};
/** @deprecated use AgentCheck */
export type ClaudeCheck = AgentCheck;

export type Bookmark = {
  id: number;
  url: string;
  title: string;
  favicon: string | null; // data: URI, fetched server-side
  created_at: number;
  updated_at: number;
};

export type Job = {
  id: number;
  name: string;
  description: string;
  schedule: string; // 5-field cron expression, UTC
  script_path: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_exit_code: number | null;
  last_output: string | null;
  consecutive_failures: number;
  next_run_at: number | null;
  running: boolean;
};

export type MessageLogEntry = {
  id: number;
  created_at: number;
  direction: 'in' | 'out';
  text: string;
  session_id: string | null;
  ok: boolean;
  error: string | null;
};

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

export const api = {
  status: () => request<Status>('/status'),
  agentCheck: (engine: EngineId) =>
    request<AgentCheck>(`/agent-check?engine=${engine}`),
  authCheck: (engine: EngineId) =>
    request<EngineAuth>(`/auth-check?engine=${engine}`),
  authConfig: (engine: EngineId) =>
    request<AuthConfig>(`/auth-config?engine=${engine}`),
  setAuthConfig: (
    engine: EngineId,
    body: { method?: AuthMethod; apiKey?: string }
  ) =>
    request<{ ok: true } & AuthConfig>('/auth-config', {
      method: 'POST',
      body: JSON.stringify({ engine, ...body }),
    }),
  claudeLoginStart: () =>
    request<{ url: string }>('/auth/claude-login/start', { method: 'POST' }),
  claudeLoginCode: (code: string) =>
    request<{ ok: true }>('/auth/claude-login/code', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  claudeLoginStatus: () =>
    request<{ state: 'idle' | 'awaiting' | 'done' | 'error'; error?: string }>(
      '/auth/claude-login/status'
    ),
  claudeLoginCancel: () =>
    request<{ ok: true }>('/auth/claude-login/cancel', { method: 'POST' }),
  codexLoginStart: () =>
    request<{ url: string; code: string }>('/auth/codex-login/start', { method: 'POST' }),
  codexLoginState: () =>
    request<{ state: 'idle' | 'awaiting' | 'done' | 'error'; error?: string }>(
      '/auth/codex-login/status'
    ),
  codexLoginCancel: () =>
    request<{ ok: true }>('/auth/codex-login/cancel', { method: 'POST' }),
  setEngine: (engine: EngineId) =>
    request<{ ok: true; engine: EngineId }>('/engine', {
      method: 'POST',
      body: JSON.stringify({ engine }),
    }),
  saveToken: (token: string) =>
    request<{ ok: true; bot: BotInfo }>('/onboarding/save-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  qrStart: () => request<QrPairing>('/onboarding/qr/start', { method: 'POST' }),
  qrPoll: (id: string) => request<QrPollResult>(`/onboarding/qr/${id}`),
  qrCancel: (id: string) =>
    request<{ ok: true }>(`/onboarding/qr/${id}/cancel`, { method: 'POST' }),
  startCapture: () =>
    request<{ ok: true }>('/onboarding/start-capture', { method: 'POST' }),
  cancelCapture: () =>
    request<{ ok: true }>('/onboarding/cancel-capture', { method: 'POST' }),
  captured: () => request<{ chat_id: string | null }>('/onboarding/captured'),
  groupStartCapture: (mode: GroupCaptureMode) =>
    request<{ ok: true; mode: GroupCaptureMode }>('/group/start-capture', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  groupCancelCapture: () =>
    request<{ ok: true }>('/group/cancel-capture', { method: 'POST' }),
  groupStatus: () =>
    request<{ capturing: boolean; mode: GroupCaptureMode | null; groups: GroupLink[] }>(
      '/group/status'
    ),
  groupUnlink: (id: number) =>
    request<{ ok: true }>('/group/unlink', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  setRelay: (enabled: boolean) =>
    request<{ ok: true; enabled: boolean }>('/relay', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  bookmarks: () => request<{ bookmarks: Bookmark[] }>('/bookmarks'),
  addBookmark: (body: { url: string; title?: string }) =>
    request<{ ok: true; bookmark: Bookmark }>('/bookmarks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateBookmark: (id: number, body: { url?: string; title?: string }) =>
    request<{ ok: true; bookmark: Bookmark }>(`/bookmarks/${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteBookmark: (id: number) =>
    request<{ ok: true }>(`/bookmarks/${id}`, { method: 'DELETE' }),
  refreshBookmark: (id: number) =>
    request<{ ok: true; bookmark: Bookmark; reachable: boolean }>(
      `/bookmarks/${id}/refresh`,
      { method: 'POST' }
    ),
  jobs: () => request<{ jobs: Job[] }>('/jobs'),
  updateJob: (
    id: number,
    body: { description?: string; schedule?: string; enabled?: boolean }
  ) =>
    request<{ ok: true; job: Job }>(`/jobs/${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteJob: (id: number) =>
    request<{ ok: true }>(`/jobs/${id}`, { method: 'DELETE' }),
  runJob: (id: number) =>
    request<{ ok: true; exit_code: number; output: string; sent: boolean }>(
      `/jobs/${id}/run`,
      { method: 'POST' }
    ),
  updateInfo: () => request<UpdateInfo>('/update/info'),
  updateCheck: () => request<UpdateCheck>('/update/check', { method: 'POST' }),
  updateRun: () => request<{ ok: true }>('/update/run', { method: 'POST' }),
  resetSession: () => request<{ ok: true }>('/reset-session', { method: 'POST' }),
  messages: (limit = 50) =>
    request<{ messages: MessageLogEntry[] }>(`/messages?limit=${limit}`),
  feed: (limit = 300) =>
    request<{ events: FeedEvent[] }>(`/feed?limit=${limit}`),
  reset: () => request<{ ok: true }>('/reset', { method: 'POST' }),
};
