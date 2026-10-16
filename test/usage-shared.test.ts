import { describe, expect, it } from 'vitest';
import { defaultState, normalizeState } from '../src/shared/state';
import { sanitizeUsage } from '../src/main/usage/sanitize';
import { MAIN_ACCOUNTS, claudeLoginActions, clampPercent, effectivePercent, formatDuration, heldByOf, usageBand, usageDiagnostics, usageErrorKind, usageHttpStatus, worstPercent, type ProviderUsage } from '../src/shared/usage';
import { noticeText, setAsideText, usageErrorKey, usageMessages } from '../src/shared/usageMessages';
import { translate } from '../src/shared/i18n';

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
      accountId: 'claude:main', provider: 'claude', status: 'ok', fetchedAt: NOW, source: 'live',
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

describe('sanitizeUsage accounts', () => {
  const valid = { accountId: 'claude:main', provider: 'claude', status: 'ok', fetchedAt: NOW, source: 'live', windows: [] };

  it('lists the main accounts', () => {
    expect(MAIN_ACCOUNTS).toEqual([{ id: 'claude:main', provider: 'claude' }, { id: 'codex:main', provider: 'codex' }]);
  });

  it('requires a non-empty account id of at most 80 characters', () => {
    expect(sanitizeUsage(valid)).toMatchObject({ accountId: 'claude:main' });
    expect(sanitizeUsage({ ...valid, accountId: undefined })).toBeNull();
    expect(sanitizeUsage({ ...valid, accountId: '' })).toBeNull();
    expect(sanitizeUsage({ ...valid, accountId: 5 })).toBeNull();
    expect(sanitizeUsage({ ...valid, accountId: 'a'.repeat(81) })).toBeNull();
    expect(sanitizeUsage({ ...valid, accountId: 'a'.repeat(80) })).not.toBeNull();
  });

  it('keeps org (max 120) and managed (boolean only) and drops unknown fields', () => {
    const usage = sanitizeUsage({ ...valid, org: 'o'.repeat(200), managed: true, token: 'SECRET' });
    expect(usage?.org).toHaveLength(120);
    expect(usage?.managed).toBe(true);
    expect(usage).not.toHaveProperty('token');
    expect(sanitizeUsage({ ...valid, managed: 'yes', org: 5 })).not.toHaveProperty('managed');
    expect(sanitizeUsage({ ...valid, managed: 'yes', org: 5 })).not.toHaveProperty('org');
    expect(sanitizeUsage({ ...valid, managed: false })?.managed).toBe(false);
  });
});

describe('claudeLoginActions', () => {
  it('on macOS offers the main login only and hides managed-account actions', () => {
    expect(claudeLoginActions('darwin', false)).toEqual({ menu: 'main', emptyTarget: 'main', managedAccounts: false });
    expect(claudeLoginActions('darwin', true)).toEqual({ menu: null, emptyTarget: 'main', managedAccounts: false });
  });

  it('keeps Windows and Linux behaviour: add account, managed actions available', () => {
    for (const platform of ['win32', 'linux']) {
      for (const has of [false, true]) expect(claudeLoginActions(platform, has)).toEqual({ menu: 'new', emptyTarget: 'new', managedAccounts: true });
    }
  });
});

describe('failure reasons', () => {
  it('groups reason codes into what the card says', () => {
    expect(usageErrorKind('http-429')).toBe('rate');
    expect(usageErrorKind('refresh-http-429')).toBe('refreshLimited');
    expect(usageErrorKind('http-503')).toBe('server');
    expect(usageErrorKind('network')).toBe('network');
    expect(usageErrorKind('timeout')).toBe('network');
    expect(usageErrorKind('bad-response')).toBe('parse');
    expect(usageErrorKind('no-windows')).toBe('empty');
    expect(usageErrorKind('refresh-network')).toBe('refresh');
    expect(usageErrorKind('refresh-http-500')).toBe('refresh');
    expect(usageErrorKind('refresh-blocked')).toBe('blocked');
    expect(usageErrorKind('http-418')).toBe('other');
    expect(usageErrorKind(undefined)).toBe('other');
  });

  it('has a translated card text for every kind and extracts the HTTP status', () => {
    for (const kind of ['rate', 'server', 'network', 'parse', 'empty', 'refresh', 'refreshLimited', 'blocked', 'other'] as const) {
      expect(usageMessages[usageErrorKey(kind)]).toHaveLength(5);
    }
    expect(usageHttpStatus('http-429')).toBe(429);
    expect(usageHttpStatus('refresh-http-503')).toBe(503);
    expect(usageHttpStatus('network')).toBeUndefined();
  });

  it('builds a diagnostics text with reason, status and ages but no secrets', () => {
    const usage: ProviderUsage = {
      accountId: 'claude:abc', provider: 'claude', status: 'error', plan: 'Team 5x', managed: true, heldBy: 'cswap', error: 'http-429',
      windows: [{ id: '5h', usedPercent: 0, resetsAt: 0 }, { id: '7d', usedPercent: 100, resetsAt: 1 }],
      fetchedAt: NOW - 15 * 60_000, source: 'cache', attemptAt: NOW - 60_000, retryAt: NOW + 9 * 60_000, email: 'x@example.com',
    };
    const text = usageDiagnostics(usage, NOW, 'APP_label');
    expect(text).toContain('account: APP_label');
    expect(text).toContain('reason: http-429');
    expect(text).toContain('http status: 429');
    expect(text).toContain('last good data 15 min ago');
    expect(text).toContain('last attempt: 1 min ago');
    expect(text).toContain('next attempt: in 9 min');
    expect(text).toContain('7d 100%');
    expect(text).not.toContain('example.com');
    expect(text).toContain('renewal: held (cswap)');
    expect(usageDiagnostics({ ...usage, heldBy: undefined, active: true }, NOW, 'a')).toContain('active login: yes');
  });

  it('keeps the new fields through sanitizing and drops bad ones', () => {
    const base = { accountId: 'claude:abc', provider: 'claude', status: 'error', windows: [], fetchedAt: NOW, source: 'live' };
    expect(sanitizeUsage({ ...base, attemptAt: NOW, retryAt: NOW + 5, active: true, heldBy: 'live' })).toMatchObject({ attemptAt: NOW, retryAt: NOW + 5, active: true, heldBy: 'live' });
    const bad = sanitizeUsage({ ...base, attemptAt: 'x', retryAt: -1, active: 'yes', heldBy: 'nobody', shared: true });
    expect(bad).not.toHaveProperty('attemptAt');
    expect(bad).not.toHaveProperty('retryAt');
    expect(bad).not.toHaveProperty('active');
    expect(bad).not.toHaveProperty('heldBy');
    expect(bad).not.toHaveProperty('shared');
    expect(sanitizeUsage({ ...base, status: 'elsewhere' })?.status).toBe('elsewhere');
  });

  it('names who holds a saved account whose tokens are not renewed', () => {
    expect(heldByOf(undefined)).toBeUndefined();
    expect(heldByOf('allowed')).toBeUndefined();
    expect(heldByOf('held-by-live')).toBe('live');
    expect(heldByOf('held-by-cswap')).toBe('cswap');
    expect(heldByOf('switched-out')).toBe('switched-out');
  });
});

describe('account notices', () => {
  it('has a text for every kind, naming the account, in every language', () => {
    const kinds = ['switchedOut', 'loggedOut', 'adopted', 'migrated', 'quarantined'] as const;
    for (const kind of kinds) {
      const { key, params } = noticeText({ id: 'n', kind, at: 1, email: 'g@x.com', count: 2 });
      for (const lang of ['pl', 'en', 'de', 'es', 'fr', 'pt'] as const) {
        const text = translate(lang, key, params);
        expect(text.length).toBeGreaterThan(10);
        if (kind !== 'migrated') expect(text).toContain('g@x.com');
      }
    }
  });

  it('never claims a kept copy on macOS (the live login is in the Keychain) (F24)', () => {
    for (const kind of ['switchedOut', 'loggedOut'] as const) {
      const notice = { id: 'n', kind, at: 1, email: 'g@x.com' };
      const mac = noticeText(notice, 'darwin');
      expect(mac.key).not.toBe(noticeText(notice, 'win32').key);
      expect(noticeText(notice).key).toBe(noticeText(notice, 'win32').key);
      for (const lang of ['pl', 'en', 'de', 'es', 'fr', 'pt'] as const) expect(translate(lang, mac.key, mac.params)).toContain('g@x.com');
      expect(translate('en', mac.key, mac.params)).not.toContain('kept its copy');
    }
    expect(noticeText({ id: 'n', kind: 'adopted', at: 1, email: 'g@x.com' }, 'darwin').key).toBe(noticeText({ id: 'n', kind: 'adopted', at: 1, email: 'g@x.com' }).key);
  });

  it('tells why a card is set aside after a failed restore and what to do, naming it, in every language', () => {
    expect(setAsideText(true)).not.toBe(setAsideText(false));
    for (const restoring of [true, false]) {
      for (const lang of ['pl', 'en', 'de', 'es', 'fr', 'pt'] as const) expect(translate(lang, setAsideText(restoring), { email: 'g@x.com' })).toContain('g@x.com');
    }
    expect(translate('en', setAsideText(false), { email: 'g@x.com' })).toMatch(/sign in to it again or remove the account/i);
  });
});
