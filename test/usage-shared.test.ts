import { describe, expect, it } from 'vitest';
import { defaultState, normalizeState } from '../src/shared/state';
import { clampPercent, effectivePercent, formatDuration, usageBand, worstPercent, type ProviderUsage } from '../src/shared/usage';

const NOW = Date.parse('2026-10-11T12:00:00Z');

describe('usage helpers', () => {
  it('clamps percentages and rejects non-numbers', () => {
    expect(clampPercent(142)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(41.5)).toBe(41.5);
  });

  it('treats a window that already reset as unused', () => {
    const past = Math.floor(NOW / 1000) - 1;
    expect(effectivePercent({ id: '5h', usedPercent: 80, resetsAt: past }, NOW)).toBe(0);
    expect(effectivePercent({ id: '5h', usedPercent: 80, resetsAt: past + 3600 }, NOW)).toBe(80);
    expect(effectivePercent({ id: '5h', usedPercent: 12, resetsAt: 0 }, NOW)).toBe(12);
    expect(effectivePercent({ id: '7d', usedPercent: 250, resetsAt: past + 60 }, NOW)).toBe(100);
  });

  it('picks the color band at 70 and 90 percent', () => {
    expect([0, 69.9, 70, 89.9, 90, 100].map(usageBand)).toEqual(['low', 'low', 'mid', 'mid', 'high', 'high']);
  });

  it('uses the highest window as the headline', () => {
    const usage: ProviderUsage = {
      provider: 'claude', status: 'ok', fetchedAt: NOW, source: 'live',
      windows: [{ id: '5h', usedPercent: 20, resetsAt: Math.floor(NOW / 1000) + 600 }, { id: '7d', usedPercent: 64, resetsAt: Math.floor(NOW / 1000) + 9000 }],
    };
    expect(worstPercent(usage, NOW)).toBe(64);
    expect(worstPercent({ ...usage, windows: [] }, NOW)).toBe(0);
  });

  it('formats durations compactly', () => {
    expect(formatDuration(-5)).toBe('<1 min');
    expect(formatDuration(59)).toBe('<1 min');
    expect(formatDuration(12 * 60)).toBe('12 min');
    expect(formatDuration(2 * 3600 + 13 * 60)).toBe('2 h 13 min');
    expect(formatDuration(3 * 3600)).toBe('3 h');
    expect(formatDuration(6 * 86400 + 8 * 3600)).toBe('6 d 8 h');
    expect(formatDuration(2 * 86400)).toBe('2 d');
  });
});

describe('usage settings', () => {
  it('shows the limits expanded and refreshes every 5 minutes by default', () => {
    expect(defaultState().settings).toMatchObject({ showAiUsage: true, usageIntervalMinutes: 5, usageCollapsed: false });
  });

  it('keeps valid choices and repairs invalid ones', () => {
    const raw = JSON.parse(JSON.stringify(defaultState()));
    Object.assign(raw.settings, { showAiUsage: false, usageIntervalMinutes: 15, usageCollapsed: true });
    expect(normalizeState(JSON.parse(JSON.stringify(raw)))!.settings).toMatchObject({ showAiUsage: false, usageIntervalMinutes: 15, usageCollapsed: true });
    Object.assign(raw.settings, { showAiUsage: 'yes', usageIntervalMinutes: 7, usageCollapsed: 1 });
    expect(normalizeState(JSON.parse(JSON.stringify(raw)))!.settings).toMatchObject({ showAiUsage: true, usageIntervalMinutes: 5, usageCollapsed: false });
    delete raw.settings.showAiUsage; delete raw.settings.usageIntervalMinutes; delete raw.settings.usageCollapsed;
    expect(normalizeState(JSON.parse(JSON.stringify(raw)))!.settings).toMatchObject({ showAiUsage: true, usageIntervalMinutes: 5, usageCollapsed: false });
  });
});
