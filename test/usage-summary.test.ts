import { describe, expect, it } from 'vitest';
import { shortAccountName, shortDuration, usageSummary, type ProviderUsage } from '../src/shared/usage';

const make = (over: Partial<ProviderUsage>): ProviderUsage => ({
  accountId: 'claude:main', provider: 'claude', status: 'ok', windows: [{ id: '5h', usedPercent: 17, resetsAt: 0 }], fetchedAt: 0, source: 'live', ...over,
});

describe('usage summary', () => {
  it('shortens the e-mail name', () => {
    expect(shortAccountName('anna.kowalska.long@x.pl', 'Claude')).toBe('anna.kowalsk');
    expect(shortAccountName(undefined, 'Claude')).toBe('Claude');
  });
  it('uses provider names with one Claude account', () => {
    expect(usageSummary([make({}), make({ accountId: 'codex:main', provider: 'codex', windows: [{ id: '5h', usedPercent: 8, resetsAt: 0 }] })], 1)).toBe('Claude 17% · Codex 8%');
  });
  it('uses e-mail names with several Claude accounts and skips expired ones', () => {
    const list = [make({ email: 'a@x.pl' }), make({ accountId: 'claude:u', email: 'b@x.pl', windows: [{ id: '5h', usedPercent: 40, resetsAt: 0 }] }), make({ accountId: 'claude:v', email: 'c@x.pl', status: 'expired' })];
    expect(usageSummary(list, 1)).toBe('a 17% · b 40%');
  });
  it('is empty with nothing to show', () => {
    expect(usageSummary([make({ status: 'signedOut' })], 1)).toBe('');
  });
});

describe('shortDuration', () => {
  it('formats compact countdowns', () => {
    expect(shortDuration(4 * 3600 + 2 * 60)).toBe('4h 2m');
    expect(shortDuration(5 * 86400 + 13 * 3600 + 59)).toBe('5d 13h');
    expect(shortDuration(2 * 86400)).toBe('2d');
    expect(shortDuration(3 * 3600)).toBe('3h');
    expect(shortDuration(12 * 60)).toBe('12m');
    expect(shortDuration(20)).toBe('<1m');
    expect(shortDuration(-5)).toBe('<1m');
  });
});
