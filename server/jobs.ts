/**
 * In-process scheduler for agent-created watcher jobs.
 *
 * Each enabled row in the `jobs` table gets a `Bun.cron` registration that
 * spawns the job's script. The output contract: a run's non-empty stdout is
 * sent to the linked Telegram chat as a rich message; empty stdout means
 * "nothing to report" and stays silent. Scripts never talk to Telegram
 * themselves — that keeps them testable by running them directly.
 *
 * Bun.cron guarantees scheduled fires of one job never overlap (the next fire
 * is computed after the callback settles); the `running` set extends that
 * guard to manual run-now requests.
 */
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { listJobs, getJob, recordJobRun, logMessage, addPendingContext, type Job } from './db.ts';
import { sendTelegramRich } from './telegram.ts';

export const JOBS_DIR = resolve('./data/jobs');

/** Cap stored/sent output so a runaway script can't bloat the DB or the chat. */
const MAX_OUTPUT = 30_000;
/** Kill a run after this long — generous so tier-2 scripts can shell out to `claude -p`. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Warn the user once after this many consecutive failures, then stay quiet. */
const FAILURE_NOTIFY_AT = 3;

const registered = new Map<number, Bun.CronJob>();
const running = new Set<number>();

export function isJobRunning(id: number): boolean {
  return running.has(id);
}

/** Next fire time for a schedule, or null if the expression never matches. */
export function nextRunAt(schedule: string, from?: number): number | null {
  try {
    return Bun.cron.parse(schedule, from)?.getTime() ?? null;
  } catch {
    return null;
  }
}

/** Validate a cron expression; returns an error message or null if fine. */
export function validateSchedule(schedule: string): string | null {
  try {
    if (!Bun.cron.parse(schedule)) return 'schedule never matches a future time';
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function commandFor(scriptPath: string): string[] {
  if (/\.(ts|js|mjs|tsx)$/.test(scriptPath)) return [process.execPath, scriptPath];
  if (scriptPath.endsWith('.sh')) return ['bash', scriptPath];
  return [scriptPath];
}

export type JobRunResult = { exit_code: number; output: string; sent: boolean };

/**
 * Persist a run's outcome; on failure, warn the user once when the job hits
 * FAILURE_NOTIFY_AT consecutive failures (then stay quiet until it recovers).
 * Every failure path — script error, missing script, spawn crash, timeout —
 * must funnel through here so none of them can fail silently forever.
 */
async function recordRunOutcome(job: Job, exitCode: number, output: string): Promise<void> {
  const updated = recordJobRun(job.id, { exit_code: exitCode, output });
  if (exitCode === 0) return;
  console.warn(`[jobs] "${job.name}" exited ${exitCode}: ${output.slice(0, 300)}`);
  if (updated && updated.consecutive_failures === FAILURE_NOTIFY_AT) {
    const warning =
      `⚠️ Scheduled job **${job.name}** has failed ${FAILURE_NOTIFY_AT} times in a row ` +
      `(exit ${exitCode}). Last error:\n\`\`\`\n${output.slice(0, 1000) || '(no output)'}\n\`\`\`\n` +
      `I'll stay quiet about it until it succeeds again — ask me to look into it or say "remove the ${job.name} job".`;
    const r = await sendTelegramRich(warning);
    logMessage({
      direction: 'out',
      text: `[job:${job.name}] ${warning}`,
      session_id: null,
      ok: r.ok,
      error: r.ok ? null : (r.error ?? null),
    });
    if (r.ok) {
      addPendingContext({
        source: `job:${job.name}`,
        kind: 'failure warning',
        text: `The scheduled job "${job.name}" has failed ${FAILURE_NOTIFY_AT} times in a row (exit ${exitCode}); the user was warned once.`,
      });
    }
  }
}

/**
 * Execute a job's script once, record the outcome, and deliver non-empty
 * stdout to Telegram. Used by both scheduled fires and the run-now API.
 */
export async function runJobNow(id: number): Promise<JobRunResult | { error: string }> {
  const job = getJob(id);
  if (!job) return { error: 'No such job' };
  if (running.has(id)) return { error: `Job "${job.name}" is already running` };
  if (!existsSync(job.script_path)) {
    const output = `script not found: ${job.script_path}`;
    await recordRunOutcome(job, 127, output);
    return { exit_code: 127, output, sent: false };
  }

  running.add(id);
  try {
    const jobDir = dirname(job.script_path);
    mkdirSync(jobDir, { recursive: true });
    const proc = Bun.spawn(commandFor(job.script_path), {
      cwd: jobDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        JOB_NAME: job.name,
        JOB_DIR: jobDir,
        STATE_FILE: join(jobDir, 'state.json'),
      },
    });
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, RUN_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killTimer);

    const message = stdout.trim().slice(0, MAX_OUTPUT);
    const stored = [
      timedOut && `[killed: run exceeded the ${RUN_TIMEOUT_MS / 60000}-minute timeout]`,
      stdout.trim(),
      stderr.trim() && `[stderr]\n${stderr.trim()}`,
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, MAX_OUTPUT);
    await recordRunOutcome(job, exitCode, stored);

    let sent = false;
    if (exitCode === 0 && message) {
      const r = await sendTelegramRich(message);
      sent = r.ok;
      // Record in the dashboard feed and queue as agent context — job output
      // goes straight to Telegram, so without this the agent never sees it.
      logMessage({
        direction: 'out',
        text: `[job:${job.name}] ${message}`,
        session_id: null,
        ok: r.ok,
        error: r.ok ? null : (r.error ?? null),
      });
      if (sent) {
        addPendingContext({ source: `job:${job.name}`, kind: 'scheduled job output', text: message });
      } else {
        console.error(`[jobs] "${job.name}" produced a message but Telegram delivery failed`);
      }
    }
    return { exit_code: exitCode, output: stored, sent };
  } catch (e) {
    const output = e instanceof Error ? e.message : String(e);
    await recordRunOutcome(job, -1, output);
    return { exit_code: -1, output, sent: false };
  } finally {
    running.delete(id);
  }
}

/**
 * Reconcile Bun.cron registrations with the DB. Cheap at this scale, so
 * mutations just call this instead of doing per-job bookkeeping.
 */
export function syncJobs(): void {
  for (const cronJob of registered.values()) cronJob.stop();
  registered.clear();
  for (const job of listJobs()) {
    if (!job.enabled) continue;
    try {
      registered.set(
        job.id,
        Bun.cron(job.schedule, async () => {
          await runJobNow(job.id);
        })
      );
    } catch (e) {
      console.error(`[jobs] failed to schedule "${job.name}" (${job.schedule}):`, e);
    }
  }
}

/** A job whose next fire after its last run is already in the past missed a
 *  firing while the relay was down — run it once to catch up. */
function catchUpMissedRuns(): void {
  const now = Date.now();
  for (const job of listJobs()) {
    if (!job.enabled || !job.last_run_at) continue;
    const due = nextRunAt(job.schedule, job.last_run_at);
    if (due !== null && due <= now) {
      console.log(`[jobs] "${job.name}" missed a run while down — catching up`);
      runJobNow(job.id).catch(() => {});
    }
  }
}

export function startJobScheduler(): void {
  syncJobs();
  // Let the relay finish booting before firing catch-up runs.
  setTimeout(catchUpMissedRuns, 5_000);
  const count = registered.size;
  if (count > 0) console.log(`[jobs] scheduler started with ${count} job(s)`);
}
