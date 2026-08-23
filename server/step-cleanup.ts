// Auto-removal of tool-step messages ("🛠 …" / "✅ …" / "🧠 thinking…") from
// the Telegram chat. Each step message sent while a TTL is configured is
// queued in the step_messages table; a background sweeper deletes it from the
// chat once it is older than the TTL. Final replies are never touched.
import {
  getSetting,
  setSetting,
  recordStepMessage,
  takeExpiredStepMessages,
  clearStepMessageQueue,
} from './db.ts';
import { deleteTelegramMessage } from './telegram.ts';

const STEP_CLEANUP_KEY = 'step_cleanup_seconds';
export const DEFAULT_STEP_CLEANUP_SECONDS = 60;

// Telegram refuses deleteMessage after 48h — anything older is permanent
// whatever the setting says, so that's also the cap for the TTL.
export const MAX_STEP_CLEANUP_SECONDS = 48 * 3600;

const SWEEP_INTERVAL_MS = 10_000;

/** Configured TTL in seconds; 0 means "never remove". */
export function getStepCleanupSeconds(): number {
  const raw = getSetting(STEP_CLEANUP_KEY);
  if (raw === null) return DEFAULT_STEP_CLEANUP_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_STEP_CLEANUP_SECONDS;
  return Math.min(n, MAX_STEP_CLEANUP_SECONDS);
}

export function setStepCleanupSeconds(seconds: number): void {
  setSetting(STEP_CLEANUP_KEY, String(seconds));
  // Switching to "never" makes the already-sent steps permanent too —
  // deleting them minutes later would contradict the user's choice.
  if (seconds === 0) clearStepMessageQueue();
}

/** Queue a just-sent step message for removal (no-op when TTL is "never"). */
export function queueStepMessageCleanup(chatId: string, messageId: number): void {
  if (getStepCleanupSeconds() === 0) return;
  recordStepMessage(chatId, messageId);
}

async function sweep(): Promise<void> {
  const ttl = getStepCleanupSeconds();
  if (ttl === 0) return;
  const expired = takeExpiredStepMessages(Date.now() - ttl * 1000);
  for (const m of expired) {
    const r = await deleteTelegramMessage(m.chat_id, m.message_id);
    // Best-effort: already deleted by the user, or past Telegram's 48h
    // window — either way the row is gone and we move on.
    if (!r.ok) console.warn(`[step-cleanup] delete failed (msg ${m.message_id}): ${r.error}`);
  }
}

export function startStepCleanupSweeper(): void {
  setInterval(() => {
    sweep().catch((err) => console.error('[step-cleanup] sweep crashed:', err));
  }, SWEEP_INTERVAL_MS);
}
