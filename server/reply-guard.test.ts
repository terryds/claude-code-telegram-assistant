import { describe, expect, test } from 'bun:test';
import { formatNonAnswerNotice, isNonAnswer, looksLikeToolTimeout } from './reply-guard.ts';

describe('isNonAnswer', () => {
  test('empty or whitespace-only results', () => {
    expect(isNonAnswer('')).toBe(true);
    expect(isNonAnswer('   \n ')).toBe(true);
    expect(isNonAnswer(null)).toBe(true);
    expect(isNonAnswer(undefined)).toBe(true);
  });

  test('the CLI stub seen in the field', () => {
    expect(isNonAnswer('No response requested.')).toBe(true);
    expect(isNonAnswer('No response requested')).toBe(true);
    expect(isNonAnswer('*No response requested.*')).toBe(true);
    expect(isNonAnswer('No further response needed.')).toBe(true);
    expect(isNonAnswer('No reply is required.')).toBe(true);
    expect(isNonAnswer('(no response)')).toBe(true);
    expect(isNonAnswer('[empty response]')).toBe(true);
    expect(isNonAnswer('Nothing to report.')).toBe(true);
    expect(isNonAnswer('Nothing to add.')).toBe(true);
  });

  test('real answers are left alone', () => {
    expect(isNonAnswer('Yes.')).toBe(false);
    expect(isNonAnswer('Done — the deploy finished at 14:02.')).toBe(false);
    expect(isNonAnswer('No.')).toBe(false);
    expect(isNonAnswer('No response from the server yet; the deploy is still running.')).toBe(false);
    expect(isNonAnswer('There is nothing to report from the logs, but the disk is 91% full.')).toBe(false);
    expect(isNonAnswer('No response requested by the API spec, so the endpoint returns 204.')).toBe(false);
    expect(isNonAnswer('The answer is 42.')).toBe(false);
  });
});

describe('looksLikeToolTimeout', () => {
  test('matches the Bash tool cap wording', () => {
    expect(looksLikeToolTimeout('Command timed out after 10m 0.0s')).toBe(true);
    expect(looksLikeToolTimeout('Error: command timed out')).toBe(true);
    expect(looksLikeToolTimeout('Process timed out after 600 seconds')).toBe(true);
  });

  test('ignores ordinary output', () => {
    expect(looksLikeToolTimeout('Build finished in 12m')).toBe(false);
    expect(looksLikeToolTimeout('')).toBe(false);
    expect(looksLikeToolTimeout(undefined)).toBe(false);
  });
});

describe('formatNonAnswerNotice', () => {
  const label = 'Claude Code';

  test('quotes the stub and names the tool cap when one fired', () => {
    const s = formatNonAnswerNotice({ text: 'No response requested.', toolTimedOut: true, label });
    expect(s).toContain('Claude Code finished without answering');
    expect(s).toContain('"No response requested."');
    expect(s).toContain('10-minute tool limit');
    expect(s).toContain('not** still running');
  });

  test('describes an empty ending without blaming a tool', () => {
    const s = formatNonAnswerNotice({ text: '', toolTimedOut: false, label });
    expect(s).toContain('empty reply');
    expect(s).not.toContain('10-minute tool limit');
  });

  test('never posts the stub bare', () => {
    const s = formatNonAnswerNotice({ text: 'No response requested.', toolTimedOut: false, label });
    expect(s.trim()).not.toBe('No response requested.');
    expect(s).toContain('Ask again');
  });
});
