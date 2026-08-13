/**
 * Customizable agent persona.
 *
 * The persona is the "who am I to the user" part of the agent's instructions —
 * historically a static section of AGENTS.md, now a setting the user can edit
 * from the dashboard (or the /persona Telegram command). It is injected into
 * the first prompt of every fresh conversation; AGENTS.md keeps only the
 * relay mechanics (formatting, URLs, notify, bookmarks).
 */
import { getSetting, setSetting, deleteSetting } from './db.ts';

const PERSONA_KEY = 'persona';

/**
 * The out-of-the-box persona (the text that used to live in AGENTS.md).
 * AGENTS.md itself carries no persona — it is pure relay mechanics; this
 * injection is the single source of persona truth.
 */
export const DEFAULT_PERSONA = `You are the user's personal assistant, chatting with them over Telegram.

When the user opens with a greeting or small talk ("hi", "heya", "nice"),
reply simply and warmly — "Hey! What can I help you with?" — no status
reports or technical detail they didn't ask for.`;

/**
 * Non-editable rules appended after the (customizable) persona in every
 * injection, so no custom persona can accidentally drop them.
 */
const PERSONA_RULES = `Whatever your persona, never name the relay's repo or project
("coding-agent-telegram-relay"), describe the relay setup, or mention that
you're running inside a repository unless the user asks about it or the task
requires it — to the user this chat is their assistant, not a project checkout.`;

/** The effective persona text: the saved custom one, or the default. */
export function getPersona(): string {
  const v = getSetting(PERSONA_KEY);
  return v && v.trim() ? v : DEFAULT_PERSONA;
}

/** Whether a custom persona is saved (vs. running on the default). */
export function isCustomPersona(): boolean {
  const v = getSetting(PERSONA_KEY);
  return Boolean(v && v.trim());
}

/** Save a custom persona; an empty/whitespace value resets to the default. */
export function setPersona(text: string): void {
  const t = text.trim();
  if (t) setSetting(PERSONA_KEY, t);
  else deleteSetting(PERSONA_KEY);
}

export function resetPersona(): void {
  deleteSetting(PERSONA_KEY);
}

/**
 * Prepend the persona to the first prompt of a fresh conversation. Resumed
 * sessions already carry it in their transcript, so it is sent only once.
 */
export function withPersona(prompt: string): string {
  return `(Persona for this conversation — stay in it for every reply:\n\n${getPersona()}\n\n${PERSONA_RULES})\n\n${prompt}`;
}
