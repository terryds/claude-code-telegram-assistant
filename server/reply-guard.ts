/**
 * Catch runs that end without an answer.
 *
 * A headless `claude -p` turn can finish with nothing useful in its result:
 * the agent started a long foreground command, the Bash tool's ~10-minute cap
 * killed it, and the turn wound down with a stub like "No response requested."
 * Posting that verbatim reads like the bot ignored the user. This module spots
 * such endings so the listener can say what happened and how to recover
 * instead of relaying the stub.
 */

/**
 * Stub endings the CLI produces when a turn closes without a real reply.
 * Matched against the whole (trimmed) result, so a genuine answer that merely
 * contains one of these phrases is left alone. Kept deliberately narrow —
 * a false positive would swallow a real reply.
 */
const NON_ANSWER_RES: RegExp[] = [
  // "No response requested." / "No response needed" / "(No reply required.)"
  /^[\s(*_`]*no\s+(?:further\s+)?(?:response|reply|answer|output)\s+(?:was\s+|is\s+)?(?:requested|needed|required|necessary)[\s.)*_`!]*$/i,
  // "(no response)" / "[empty response]" / "No output."
  /^[\s(\[*_`]*(?:no|empty)\s+(?:response|reply|output)[\s.)\]*_`]*$/i,
  // "Nothing to report." / "Nothing to add."
  /^[\s(*_`]*nothing\s+to\s+(?:report|add|respond(?:\s+to)?|say)[\s.)*_`]*$/i,
];

/** True when the turn's final text is empty or one of the known stubs. */
export function isNonAnswer(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  return NON_ANSWER_RES.some((re) => re.test(t));
}

/**
 * The Bash tool's own wording when it kills a command at its time cap. Seen
 * in the tool_result stream; a run that hit this and then ended with a stub
 * almost certainly lost its answer to the cap.
 */
const TOOL_TIMEOUT_RE =
  /command timed out|timed out after \d+\s*(?:m|min|minutes?|s|sec|seconds?)\b|exceeded (?:the )?(?:\d+[- ]?(?:minute|min|second|sec)s? )?(?:time ?)?limit/i;

export function looksLikeToolTimeout(resultText: string | null | undefined): boolean {
  return TOOL_TIMEOUT_RE.test(resultText ?? '');
}

export type NonAnswerContext = {
  /** The stub text the run ended with (empty when it produced nothing). */
  text: string;
  /** A tool call in this run was killed at its time cap. */
  toolTimedOut: boolean;
  /** Engine display name, e.g. "Claude Code". */
  label: string;
};

/**
 * The notice posted in place of the stub. GitHub-Flavored Markdown, for
 * `sendTelegramRich` (degrades to readable plain text on fallback).
 */
export function formatNonAnswerNotice(ctx: NonAnswerContext): string {
  const stub = ctx.text.trim();
  const lines: string[] = [`⚠️ **${ctx.label} finished without answering**`];
  if (stub) {
    lines.push(`_The run ended with "${stub.slice(0, 120)}" instead of a reply._`);
  } else {
    lines.push('_The run ended with an empty reply._');
  }
  lines.push('');
  if (ctx.toolTimedOut) {
    lines.push(
      'A command in this run hit the 10-minute tool limit and was killed, which is usually how the answer gets lost. Anything it was doing is **not** still running.'
    );
  } else {
    lines.push(
      'This usually happens when a long-running command got cut off before the answer was written.'
    );
  }
  lines.push('');
  lines.push(
    'Ask again and I will answer first; if the task is long, I will run it detached and report back here when it finishes.'
  );
  return lines.join('\n');
}
