import { describe, expect, test } from 'bun:test';
import {
  formatLowMemoryContext,
  formatLowMemoryWarning,
  isLowMemory,
  parseMeminfo,
  parsePs,
  parseVmStat,
  shouldWarnChat,
} from './host-memory.ts';

const MEMINFO = `MemTotal:        8130000 kB
MemFree:          210000 kB
MemAvailable:     400000 kB
Buffers:           30000 kB
Cached:          1200000 kB
SReclaimable:      80000 kB
`;

describe('parseMeminfo', () => {
  test('uses MemAvailable when present', () => {
    const r = parseMeminfo(MEMINFO)!;
    expect(r.totalBytes).toBe(8130000 * 1024);
    expect(r.availableBytes).toBe(400000 * 1024);
  });

  test('approximates MemAvailable on old kernels', () => {
    const r = parseMeminfo(MEMINFO.replace(/^MemAvailable:.*\n/m, ''))!;
    expect(r.availableBytes).toBe((210000 + 1200000 + 80000) * 1024);
  });

  test('returns null for garbage', () => {
    expect(parseMeminfo('not meminfo')).toBeNull();
  });
});

describe('isLowMemory', () => {
  const reading = { availableBytes: 400 * 1024 * 1024, totalBytes: 8 * 1024 ** 3 };
  test('compares against the MiB threshold', () => {
    expect(isLowMemory(reading, 512)).toBe(true);
    expect(isLowMemory(reading, 256)).toBe(false);
  });
  test('never low without a reading or with the guard disabled', () => {
    expect(isLowMemory(null, 512)).toBe(false);
    expect(isLowMemory(reading, 0)).toBe(false);
  });
});

describe('parsePs', () => {
  test('sorts by RSS, heaviest first, skipping the header', () => {
    const rows = parsePs(
      [
        '    PID   RSS ELAPSED COMMAND',
        '   1234 20480     120 bun server/index.ts',
        '   2345 409600   86400 node /srv/preview-foo/dist/index.js',
        'garbage line',
      ].join('\n')
    );
    expect(rows.map((r) => r.pid)).toEqual([2345, 1234]);
    expect(rows[0].rssBytes).toBe(409600 * 1024);
    expect(rows[0].uptimeSec).toBe(86400);
    expect(rows[0].pm2).toBe(false);
  });

  test('handles the macOS layout without an elapsed column', () => {
    const rows = parsePs(['  PID   RSS COMMAND', ' 77 1024 /usr/bin/foo --bar'].join('\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 77, rssBytes: 1024 * 1024, uptimeSec: null, name: '/usr/bin/foo --bar' });
  });
});

describe('parseVmStat', () => {
  test('sums free, inactive and speculative pages', () => {
    const r = parseVmStat(
      [
        'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
        'Pages free:                               1000.',
        'Pages active:                           500000.',
        'Pages inactive:                           2000.',
        'Pages speculative:                         500.',
        'Pages wired down:                       100000.',
      ].join('\n'),
      32 * 1024 ** 3
    )!;
    expect(r.availableBytes).toBe(3500 * 16384);
    expect(r.totalBytes).toBe(32 * 1024 ** 3);
  });
  test('null without a page size', () => {
    expect(parseVmStat('nope', 1)).toBeNull();
  });
});

describe('formatting', () => {
  const check = {
    low: true,
    thresholdMb: 512,
    reading: { availableBytes: 300 * 1024 * 1024, totalBytes: 8 * 1024 ** 3 },
    heavy: [
      { name: 'preview-shop-42', pid: 10, rssBytes: 900 * 1024 * 1024, uptimeSec: 3 * 86400, pm2: true },
      { name: 'node /x/y.js', pid: 11, rssBytes: 100 * 1024 * 1024, uptimeSec: null, pm2: false },
    ],
  };

  test('warning names the pm2 process, size and age', () => {
    const w = formatLowMemoryWarning(check);
    expect(w).toContain('300 MB available of 8192 MB');
    expect(w).toContain('`preview-shop-42` (pm2) — 900 MB, up 3d');
    expect(w).toContain('(pid 11) — 100 MB');
  });

  test('warning without process list is a single line', () => {
    expect(formatLowMemoryWarning({ ...check, heavy: [] })).not.toContain('\n');
  });

  test('context preamble points the agent at the cleanup tools', () => {
    const c = formatLowMemoryContext(check);
    expect(c.startsWith('(Host memory warning:')).toBe(true);
    expect(c).toContain('bin/preview gc');
    expect(c).toContain('preview-shop-42 (pm2)');
    expect(c.endsWith(')')).toBe(true);
  });
});

describe('shouldWarnChat', () => {
  test('rate-limits per chat', () => {
    const t0 = 1_000_000_000;
    expect(shouldWarnChat('a', t0)).toBe(true);
    expect(shouldWarnChat('a', t0 + 60_000)).toBe(false);
    expect(shouldWarnChat('b', t0 + 60_000)).toBe(true);
    expect(shouldWarnChat('a', t0 + 16 * 60_000)).toBe(true);
  });
});
