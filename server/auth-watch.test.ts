import { describe, expect, test } from 'bun:test';
import { isAuthError } from './engine.ts';
import { expiryStage } from './auth-watch.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('isAuthError', () => {
  test('matches the CLI sign-out wordings across versions', () => {
    for (const msg of [
      'Not logged in · Please run /login',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'API Error: 401 Unauthorized',
      'Invalid API key · Please run /login',
      'OAuth token has expired',
      'authentication_error: invalid x-api-key',
    ]) {
      expect(isAuthError(msg)).toBe(true);
    }
  });

  test('leaves ordinary run failures alone', () => {
    for (const msg of [
      'Failed to parse claude JSON output: Unexpected end of JSON input',
      'Stopped by user.',
      'Claude timed out after 10 minutes.',
      'The token budget was exhausted before the task completed',
    ]) {
      expect(isAuthError(msg)).toBe(false);
    }
  });
});

describe('expiryStage', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  test('quiet while more than 3 days remain', () => {
    expect(expiryStage(now + 10 * DAY, now)).toBeNull();
    expect(expiryStage(now + 3 * DAY + 1, now)).toBeNull();
  });
  test('escalates 3d → 1d → expired', () => {
    expect(expiryStage(now + 3 * DAY, now)).toBe('3d');
    expect(expiryStage(now + 2 * DAY, now)).toBe('3d');
    expect(expiryStage(now + DAY, now)).toBe('1d');
    expect(expiryStage(now + 60_000, now)).toBe('1d');
    expect(expiryStage(now, now)).toBe('expired');
    expect(expiryStage(now - DAY, now)).toBe('expired');
  });
});
