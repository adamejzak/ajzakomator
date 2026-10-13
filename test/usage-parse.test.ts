// test/usage-parse.test.ts
import { describe, expect, it } from 'vitest';
import { decodeJwtClaims, parseClaudeUsage, parseCodexPlan, parseCodexRateLimits } from '../src/main/usage/parse';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('Claude usage body', () => {
  it('reads both windows with their reset times', () => {
    const body = {
      five_hour: { utilization: 42.4, resets_at: '2026-10-11T15:00:00.123456+00:00' },
      seven_day: { utilization: 7, resets_at: '2026-10-17T04:00:00Z' },
      extra_usage: { is_enabled: false },
    };
    expect(parseClaudeUsage(body)).toEqual([
      { id: '5h', usedPercent: 42.4, resetsAt: epoch('2026-10-11T15:00:00Z') },
      { id: '7d', usedPercent: 7, resetsAt: epoch('2026-10-17T04:00:00Z') },
    ]);
  });

  it('keeps percentages inside 0 to 100 and accepts numeric strings', () => {
    const windows = parseClaudeUsage({ five_hour: { utilization: 142, resets_at: null }, seven_day: { utilization: '55', resets_at: '2026-10-17T04:00:00Z' } });
    expect(windows?.map((w) => w.usedPercent)).toEqual([100, 55]);
    expect(parseClaudeUsage({ five_hour: { utilization: -4, resets_at: null } })?.[0].usedPercent).toBe(0);
  });

  it('reads an exhausted account: 100 percent, null resets, null windows and unrelated extra fields', () => {
    const body = {
      five_hour: { utilization: 0.0, resets_at: null },
      seven_day: { utilization: 100.0, resets_at: '2026-10-15T21:59:59.943648+00:00' },
      seven_day_oauth_apps: null,
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 12, resets_at: null },
      iguana_necktie: null,
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    };
    expect(parseClaudeUsage(body)).toEqual([{ id: '5h', usedPercent: 0, resetsAt: 0 }, { id: '7d', usedPercent: 100, resetsAt: Date.parse('2026-10-15T21:59:59Z') / 1000 }]);
    expect(parseClaudeUsage({ five_hour: null, seven_day: { utilization: 137, resets_at: null } })).toEqual([{ id: '7d', usedPercent: 100, resetsAt: 0 }]);
    expect(parseClaudeUsage({ five_hour: null, seven_day: null })).toEqual([]);
  });

  it('reports no reset time when no window is active', () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 3, resets_at: 'garbage' } })?.map((w) => w.resetsAt)).toEqual([0, 0]);
  });

  it('uses the windows that are present and rejects bodies without any', () => {
    expect(parseClaudeUsage({ seven_day: { utilization: 3, resets_at: null } })).toHaveLength(1);
    expect(parseClaudeUsage({ five_hour: {}, seven_day: { utilization: 'n/a' } })).toEqual([]);
    expect(parseClaudeUsage({ unrelated: 1 })).toBeNull();
    expect(parseClaudeUsage({})).toBeNull();
    expect(parseClaudeUsage(null)).toBeNull();
    expect(parseClaudeUsage([])).toBeNull();
    expect(parseClaudeUsage('error')).toBeNull();
  });
});

describe('Codex rate limits', () => {
  it('reads the session log shape (minutes, epoch seconds)', () => {
    const event = {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 8, window_minutes: 300, resets_at: 1781010642 },
        secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1781558816 },
        plan_type: 'plus',
      },
    };
    expect(parseCodexRateLimits(event, NOW)).toEqual([
      { id: '5h', usedPercent: 8, resetsAt: 1781010642 },
      { id: '7d', usedPercent: 3, resetsAt: 1781558816 },
    ]);
    expect(parseCodexPlan(event)).toBe('plus');
  });

  it('reads the live shape (seconds, relative or absolute reset)', () => {
    const body = {
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 1781010642 },
        secondary_window: { used_percent: 30, limit_window_seconds: 604800, reset_after_seconds: 1000 },
      },
    };
    expect(parseCodexRateLimits(body, NOW)).toEqual([
      { id: '5h', usedPercent: 12.5, resetsAt: 1781010642 },
      { id: '7d', usedPercent: 30, resetsAt: Math.floor(NOW / 1000) + 1000 },
    ]);
    expect(parseCodexPlan(body)).toBe('pro');
  });

  it('accepts windows at the top level and epoch milliseconds', () => {
    const windows = parseCodexRateLimits({ primary: { used_percent: 1, resets_at: 1781010642000 } }, NOW);
    expect(windows).toEqual([{ id: '5h', usedPercent: 1, resetsAt: 1781010642 }]);
  });

  it('classifies windows by length and never gives two windows the same id', () => {
    const long = parseCodexRateLimits({ primary: { used_percent: 5, window_seconds: 0, limit_window_seconds: 604800, resets_at: 1 } }, NOW);
    expect(long?.[0].id).toBe('7d');
    const same = parseCodexRateLimits({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 2, window_minutes: 300, resets_at: 2 } }, NOW);
    expect(same?.map((w) => w.id)).toEqual(['5h', '7d']);
  });

  it('returns null when there are no usable windows', () => {
    expect(parseCodexRateLimits({ rate_limits: { primary: null, secondary: null } }, NOW)).toBeNull();
    expect(parseCodexRateLimits({ rate_limits: { primary: { used_percent: 'x' } } }, NOW)).toBeNull();
    expect(parseCodexRateLimits(undefined, NOW)).toBeNull();
    expect(parseCodexRateLimits({}, NOW)).toBeNull();
    expect(parseCodexPlan({})).toBeUndefined();
  });
});

describe('JWT claims', () => {
  it('decodes the payload without verifying anything', () => {
    const token = `${b64url({ alg: 'none' })}.${b64url({ email: 'a@b.pl', exp: 1781010642 })}.signature`;
    expect(decodeJwtClaims(token)).toEqual({ email: 'a@b.pl', exp: 1781010642 });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeJwtClaims('')).toBeNull();
    expect(decodeJwtClaims('only-one-part')).toBeNull();
    expect(decodeJwtClaims('a.%%%.c')).toBeNull();
    expect(decodeJwtClaims(`a.${b64url([1, 2])}.c`)).toBeNull();
  });
});
