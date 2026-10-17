import { describe, expect, it } from 'vitest';
import { createReloadLimiter, createReportLimiter, describeError, rendererReport, TerminalPids, trimNotifications } from '../src/main/stability';

describe('renderer reload limit', () => {
  it('reloads a crashed renderer 3 times a minute, then leaves it to the user', () => {
    const allow = createReloadLimiter();
    expect([0, 1000, 2000].map((t) => allow(t))).toEqual([true, true, true]);
    expect(allow(3000)).toBe(false);
    expect(allow(59_999)).toBe(false);
    // The first crash left the window: one more automatic reload.
    expect(allow(60_000)).toBe(true);
    expect(allow(60_500)).toBe(false);
  });
});

describe('renderer error reports', () => {
  it('limits the reports per minute', () => {
    const allow = createReportLimiter(2, 1000);
    expect([allow(0), allow(1), allow(2)]).toEqual([true, true, false]);
    expect(allow(1000)).toBe(true);
  });

  it('accepts only well-formed reports and cuts them', () => {
    expect(rendererReport('boundary', 'cell: boom', 'at x')).toBe('renderer boundary: cell: boom\nat x');
    expect(rendererReport('Bad Kind!', 'x')).toBeNull();
    expect(rendererReport('boot', { message: 'x' })).toBeNull();
    expect(rendererReport('boot', 'x'.repeat(10_000))!.length).toBeLessThan(4100);
  });

  it('describes anything thrown', () => {
    expect(describeError(new Error('boom'))).toContain('boom');
    expect(describeError('plain')).toBe('plain');
    expect(describeError('y'.repeat(50), 10)).toBe(`${'y'.repeat(10)}…`);
  });
});

describe('live notifications', () => {
  it('keeps only the newest ones', () => {
    const set = new Set([1, 2, 3, 4, 5]);
    expect(trimNotifications(set, 3)).toEqual([1, 2]);
    expect([...set]).toEqual([3, 4, 5]);
    expect(trimNotifications(set, 3)).toEqual([]);
  });
});

describe('terminal pids', () => {
  it('returns the terminals a shutdown left behind, once', () => {
    const pids = new TerminalPids();
    pids.spawned('a', 100);
    pids.spawned('b', 200);
    pids.spawned('ssh', 0); // SSH sessions have no local process
    pids.ended('a');
    expect(pids.takeSurvivors()).toEqual([200]);
    expect(pids.takeSurvivors()).toEqual([]);
  });
});
