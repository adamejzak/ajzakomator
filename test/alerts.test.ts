import { describe, expect, it } from 'vitest';
import {
  alertEventOf, ALERT_EVENTS, decideAlert, defaultAlerts, ERROR_PHRASES, errorPhrase, inQuietHours, migrateLegacyAlerts, normalizeAlerts,
  type AlertContext, type AlertSettings,
} from '../src/shared/alerts';
import { messages } from '../src/shared/messages';
import { createSoundThrottle } from '../src/shared/sound';
import { defaultState, normalizeState } from '../src/shared/state';

const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m);
const ctx = (patch: Partial<AlertContext> = {}): AlertContext => ({
  prev: 'working', status: 'waiting', cause: 'hook', hooked: true, reason: 'done', userLooking: false, agent: true, now: at(12), ...patch,
});
const withAlerts = (patch: Partial<AlertSettings>): AlertSettings => ({ ...defaultAlerts(), ...patch });

describe('decideAlert', () => {
  it('chooses the event from the hook reason', () => {
    expect(decideAlert(defaultAlerts(), ctx({ reason: 'done' })).event).toBe('done');
    expect(decideAlert(defaultAlerts(), ctx({ reason: 'attention' })).event).toBe('attention');
    expect(decideAlert(defaultAlerts(), ctx({ reason: 'error' })).event).toBe('error');
  });

  it('treats a heuristic waiting as finished whatever its reason', () => {
    expect(alertEventOf('heuristic', 'done')).toBe('done');
    expect(alertEventOf('heuristic', 'attention')).toBe('done');
    const decision = decideAlert(defaultAlerts(), ctx({ cause: 'heuristic', hooked: false, reason: 'done' }));
    expect(decision).toMatchObject({ event: 'done', notify: true, sound: { kind: 'preset', id: 'ding-dong' } });
  });

  it('returns the configured sound and notify flag of the event', () => {
    const a = defaultAlerts();
    a.events.attention = { notify: false, sound: { kind: 'file', path: 'C:\\a.wav' } };
    expect(decideAlert(a, ctx({ reason: 'attention' }))).toEqual({ event: 'attention', notify: false, sound: { kind: 'file', path: 'C:\\a.wav' } });
    a.events.done.sound = { kind: 'off' };
    expect(decideAlert(a, ctx())).toEqual({ event: 'done', notify: true, sound: null });
  });

  it('raises nothing for an event with both notification and sound off', () => {
    const a = defaultAlerts();
    a.events.error = { notify: false, sound: { kind: 'off' } };
    expect(decideAlert(a, ctx({ reason: 'error' }))).toEqual({ event: 'error', notify: false, sound: null });
  });

  it('never alerts for shell cells', () => {
    expect(decideAlert(defaultAlerts(), ctx({ agent: false }))).toMatchObject({ notify: false, sound: null });
  });

  it('keeps the transition rules: no alert on restore, none for a stall-based waiting of a hooked cell', () => {
    // idle -> waiting by heuristic (restore / launch)
    expect(decideAlert(defaultAlerts(), ctx({ prev: 'idle', cause: 'heuristic', hooked: false }))).toMatchObject({ notify: false, sound: null });
    // already waiting, or exited -> waiting
    expect(decideAlert(defaultAlerts(), ctx({ prev: 'waiting' }))).toMatchObject({ notify: false, sound: null });
    expect(decideAlert(defaultAlerts(), ctx({ prev: 'exited' }))).toMatchObject({ notify: false, sound: null });
    // lost Stop: the silence net of a hooked cell is not an alert
    expect(decideAlert(defaultAlerts(), ctx({ cause: 'heuristic', hooked: true }))).toMatchObject({ notify: false, sound: null });
    // a heuristic cell that was working does alert
    expect(decideAlert(defaultAlerts(), ctx({ cause: 'heuristic', hooked: false }))).toMatchObject({ notify: true });
    // not waiting at all
    expect(decideAlert(defaultAlerts(), ctx({ status: 'working' }))).toMatchObject({ notify: false, sound: null });
  });

  it('stays silent while the user looks at the cell, unless notifyWhenFocused', () => {
    expect(decideAlert(defaultAlerts(), ctx({ userLooking: true }))).toMatchObject({ notify: false, sound: null });
    const focused = withAlerts({ notifyWhenFocused: true });
    expect(decideAlert(focused, ctx({ userLooking: true }))).toMatchObject({ notify: true, sound: { kind: 'preset' } });
    expect(decideAlert(focused, ctx({ userLooking: false }))).toMatchObject({ notify: true });
  });

  it('quiet hours silence both the notification and the sound', () => {
    const quiet = withAlerts({ quietHours: { enabled: true, start: '22:00', end: '07:00' } });
    expect(decideAlert(quiet, ctx({ now: at(23) }))).toMatchObject({ notify: false, sound: null });
    expect(decideAlert(quiet, ctx({ now: at(3) }))).toMatchObject({ notify: false, sound: null });
    expect(decideAlert(quiet, ctx({ now: at(12) }))).toMatchObject({ notify: true, sound: { kind: 'preset' } });
    // also with notifyWhenFocused
    expect(decideAlert({ ...quiet, notifyWhenFocused: true }, ctx({ now: at(23), userLooking: true }))).toMatchObject({ notify: false, sound: null });
  });

  it('throttles bursts of sounds but not the notifications, and only counts sounds that would play', () => {
    const allow = createSoundThrottle(1000);
    const first = decideAlert(defaultAlerts(), ctx({ allowSound: allow }));
    const second = decideAlert(defaultAlerts(), ctx({ allowSound: allow }));
    expect(first.sound).not.toBeNull();
    expect(second).toMatchObject({ notify: true, sound: null });
    // a silent event does not consume the window
    const quiet = createSoundThrottle(1000);
    const a = defaultAlerts();
    a.events.done.sound = { kind: 'off' };
    decideAlert(a, ctx({ allowSound: quiet }));
    expect(decideAlert(defaultAlerts(), ctx({ allowSound: quiet })).sound).not.toBeNull();
  });
});

describe('inQuietHours', () => {
  const q = (start: string, end: string, enabled = true) => ({ enabled, start, end });
  it('handles a same-day range', () => {
    expect(inQuietHours(q('09:00', '17:00'), at(9))).toBe(true);
    expect(inQuietHours(q('09:00', '17:00'), at(16, 59))).toBe(true);
    expect(inQuietHours(q('09:00', '17:00'), at(17))).toBe(false);
    expect(inQuietHours(q('09:00', '17:00'), at(8, 59))).toBe(false);
  });
  it('handles a range that wraps midnight', () => {
    expect(inQuietHours(q('22:00', '07:00'), at(22))).toBe(true);
    expect(inQuietHours(q('22:00', '07:00'), at(0, 30))).toBe(true);
    expect(inQuietHours(q('22:00', '07:00'), at(6, 59))).toBe(true);
    expect(inQuietHours(q('22:00', '07:00'), at(7))).toBe(false);
    expect(inQuietHours(q('22:00', '07:00'), at(21, 59))).toBe(false);
  });
  it('is off when disabled, empty or malformed', () => {
    expect(inQuietHours(q('22:00', '07:00', false), at(23))).toBe(false);
    expect(inQuietHours(q('10:00', '10:00'), at(10))).toBe(false);
    expect(inQuietHours(q('25:00', '07:00'), at(23))).toBe(false);
  });
});

describe('error phrases', () => {
  it('maps every documented code to a translated phrase and falls back to unknown', () => {
    expect(errorPhrase('rate_limit')).toBe('limit osiągnięty');
    expect(errorPhrase('nope')).toBe('nieznany błąd');
    expect(errorPhrase(undefined)).toBe('nieznany błąd');
    expect(errorPhrase('__proto__')).toBe('nieznany błąd');
    for (const key of Object.values(ERROR_PHRASES)) expect(Object.hasOwn(messages, key)).toBe(true);
    for (const key of ['{name} skończył pracę', '{name} potrzebuje Ciebie', '{name} - błąd: {detail}']) expect(Object.hasOwn(messages, key)).toBe(true);
  });
});

describe('alerts normalization', () => {
  it('defaults: everything on, one preset per event, volume 0.7, quiet hours off', () => {
    const a = defaultAlerts();
    expect(a.volume).toBe(0.7);
    expect(a.notifyWhenFocused).toBe(false);
    expect(a.quietHours).toEqual({ enabled: false, start: '22:00', end: '07:00' });
    for (const e of ALERT_EVENTS) expect(a.events[e].notify).toBe(true);
    expect(defaultState().settings.alerts).toEqual(a);
  });

  it('keeps valid values', () => {
    const raw = {
      volume: 0.35, notifyWhenFocused: true, quietHours: { enabled: true, start: '23:15', end: '06:45' },
      events: {
        done: { notify: false, sound: { kind: 'file', path: 'C:\\a\\b.wav' } },
        attention: { notify: true, sound: { kind: 'system' } },
        error: { notify: true, sound: { kind: 'preset', id: 'retro' } },
      },
    };
    expect(normalizeAlerts(JSON.parse(JSON.stringify(raw)))).toEqual(raw);
  });

  it('falls back field by field for garbage', () => {
    const d = defaultAlerts();
    expect(normalizeAlerts(undefined)).toEqual(d);
    expect(normalizeAlerts('x')).toEqual(d);
    expect(normalizeAlerts([])).toEqual(d);
    const bad = normalizeAlerts({
      volume: 'loud', notifyWhenFocused: 1, quietHours: { enabled: 'yes', start: '7pm', end: 5 },
      events: {
        done: { notify: 'x', sound: { kind: 'preset', id: 'nope' } },
        attention: { notify: false, sound: { kind: 'file', path: 5 } },
        error: { sound: { kind: 'file', path: '' } },
      },
    });
    expect(bad).toEqual({ ...d, events: { ...d.events, attention: { notify: false, sound: d.events.attention.sound } } });
    expect(normalizeAlerts({ events: { done: { sound: { kind: 'file', path: 'a\0.wav' } } } }).events.done.sound).toEqual(d.events.done.sound);
  });

  it('clamps and rounds the volume', () => {
    expect(normalizeAlerts({ volume: 5 }).volume).toBe(1);
    expect(normalizeAlerts({ volume: -2 }).volume).toBe(0);
    expect(normalizeAlerts({ volume: 0.333 }).volume).toBe(0.33);
    expect(normalizeAlerts({ volume: NaN }).volume).toBe(0.7);
  });
});

describe('migration of the retired settings', () => {
  const migrate = (settings: Record<string, unknown>) => normalizeState({ ...JSON.parse(JSON.stringify(defaultState())), settings: { ...settings } })!.settings;
  const off = { kind: 'off' };

  it('a fresh install (no retired keys) gets the defaults', () => {
    expect(migrate({ language: 'en' }).alerts).toEqual(defaultAlerts());
    expect(migrateLegacyAlerts({})).toEqual(defaultAlerts());
  });

  it('off stays off for every event; the notifications flag and the focus option carry over', () => {
    const { alerts } = migrate({ notifications: false, waitingSound: 'off', waitingSoundFile: '', waitingSoundVolume: 70, notifyWhenFocused: true });
    expect(alerts.volume).toBe(0.7);
    expect(alerts.notifyWhenFocused).toBe(true);
    for (const e of ALERT_EVENTS) expect(alerts.events[e]).toEqual({ notify: false, sound: off });
  });

  it('the system sound moves to finished and needs-you', () => {
    const { alerts } = migrate({ notifications: true, waitingSound: 'system', waitingSoundFile: '', waitingSoundVolume: 70, notifyWhenFocused: false });
    expect(alerts.events.done).toEqual({ notify: true, sound: { kind: 'system' } });
    expect(alerts.events.attention).toEqual({ notify: true, sound: { kind: 'system' } });
    expect(alerts.events.error).toEqual({ notify: true, sound: off });
  });

  it('an own file moves to finished and needs-you with its volume (0-100 becomes 0-1)', () => {
    const { alerts } = migrate({ notifications: true, waitingSound: 'custom', waitingSoundFile: 'C:\\s\\ding.mp3', waitingSoundVolume: 30 });
    expect(alerts.volume).toBe(0.3);
    expect(alerts.events.done.sound).toEqual({ kind: 'file', path: 'C:\\s\\ding.mp3' });
    expect(alerts.events.attention.sound).toEqual({ kind: 'file', path: 'C:\\s\\ding.mp3' });
    expect(alerts.events.error.sound).toEqual(off);
  });

  it('custom without a file used to beep, so it becomes the system sound', () => {
    expect(migrate({ notifications: true, waitingSound: 'custom', waitingSoundFile: '' }).alerts.events.done.sound).toEqual({ kind: 'system' });
  });

  it('missing or garbage legacy values behave like the old defaults (sound off, notifications on, volume 70)', () => {
    const missing = migrate({ notifications: true }).alerts;
    expect(missing.volume).toBe(0.7);
    for (const e of ALERT_EVENTS) expect(missing.events[e]).toEqual({ notify: true, sound: off });
    const garbage = migrate({ notifications: 'maybe', waitingSound: 'loud', waitingSoundFile: 5, waitingSoundVolume: 'x', notifyWhenFocused: 'yes' }).alerts;
    expect(garbage.volume).toBe(0.7);
    expect(garbage.notifyWhenFocused).toBe(false);
    for (const e of ALERT_EVENTS) expect(garbage.events[e]).toEqual({ notify: true, sound: off });
    expect(migrate({ notifications: true, waitingSound: 'custom', waitingSoundFile: 'x.wav', waitingSoundVolume: 900 }).alerts.volume).toBe(1);
  });

  it('never keeps or writes the retired keys, and saved alerts win over them', () => {
    const settings = migrate({ notifications: false, waitingSound: 'system', waitingSoundFile: 'a.wav', waitingSoundVolume: 10, notifyWhenFocused: true }) as unknown as Record<string, unknown>;
    for (const key of ['notifications', 'waitingSound', 'waitingSoundFile', 'waitingSoundVolume', 'notifyWhenFocused']) expect(key in settings).toBe(false);
    const mixed = migrate({ notifications: false, waitingSound: 'system', alerts: { volume: 0.2 } }).alerts;
    expect(mixed.volume).toBe(0.2);
    expect(mixed.events.done).toEqual(defaultAlerts().events.done);
    // a second pass is stable
    const again = normalizeState(JSON.parse(JSON.stringify({ ...defaultState(), settings })))!.settings;
    expect(again.alerts).toEqual(settings.alerts);
  });
});
