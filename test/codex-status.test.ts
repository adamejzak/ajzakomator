import { describe, expect, it } from 'vitest';
import {
  alertEventOf, createTurnDedupe, decideAlert, defaultAlerts, errorPhrase, failureLabel, LIMIT_ERRORS, type AlertEventId,
} from '../src/shared/alerts';
import { FailureScanner } from '../src/shared/outputFailure';
import { automationStatusFor } from '../src/shared/runtimeStatus';
import { layoutForCount } from '../src/shared/layout';
import { addProject, addTab, defaultState, findCell, normalizeState, updateCell } from '../src/shared/state';
import {
  CODEX_GAP_MS, CODEX_QUIET_MS, CODEX_WINDOW_MS, ENV_QUIET_MS, FAILURE_QUIET_MS, shouldNotify, StatusTracker, SUSPEND_MS,
  type CellStatus, type HookInfo,
} from '../src/shared/status';

interface Flip { at: number; from: CellStatus; to: CellStatus; reason: string; event?: AlertEventId }

const LIMIT_LINE = '\x1b[31m■ You’ve hit your usage limit. Try again later.\x1b[0m\r\n';

/** One cell as the app wires it: tracker, per-turn dedupe and the pure alert decision. */
function cell(opts: { codex?: boolean; muted?: boolean } = {}) {
  const t = new StatusTracker();
  t.setCodex(opts.codex ?? true);
  const dedupe = createTurnDedupe();
  const scanner = new FailureScanner();
  const flips: Flip[] = [];
  const alerts: AlertEventId[] = [];
  const watch = (at: number, change: () => unknown) => {
    const before = t.status;
    const result = change();
    const renotify = result === 'renotify'; // reported to the alert rules as working -> waiting, like the app does
    if (t.status === before && !renotify) return;
    const prev = t.status === before ? 'working' : before;
    const flip: Flip = { at, from: prev, to: t.status, reason: t.lastReason };
    if (t.status !== before) flips.push(flip);
    if (t.status !== 'waiting') return;
    const real = shouldNotify(prev, t.status, t.lastCause, t.isHooked);
    const duplicate = real && !dedupe('c', alertEventOf(t.lastCause, t.lastReason), t.turnKey);
    const decision = decideAlert(defaultAlerts(), {
      prev, status: t.status, cause: t.lastCause, hooked: t.isHooked, reason: t.lastReason, userLooking: false, agent: true,
      muted: opts.muted, duplicate, now: new Date(2026, 9, 12, 12),
    });
    if (decision.notify || decision.sound) { alerts.push(decision.event); flip.event = decision.event; }
  };
  return {
    t, flips, alerts,
    submit: (at: number) => watch(at, () => t.input(at, true)),
    key: (at: number) => watch(at, () => t.input(at, false)),
    out: (at: number, text?: string) => watch(at, () => {
      t.output(at);
      const failure = text ? scanner.feed(text) : null;
      if (failure) t.failure(failure);
    }),
    /** Several lines of the app's own redraw at once do not matter; this is the user's answer without Enter (a plain key). */
    notify: (at: number, turnId?: string, threadId?: string) => watch(at, () => t.hook('stop', at, { codex: true, ...(turnId ? { turnId } : {}), ...(threadId ? { threadId } : {}) } as HookInfo)),
    /** A notify followed by quiet: the ticks of the app commit the turn end. */
    end: (at: number, turnId?: string, threadId?: string) => {
      watch(at, () => t.hook('stop', at, { codex: true, ...(turnId ? { turnId } : {}), ...(threadId ? { threadId } : {}) } as HookInfo));
      for (let n = at + 400; n <= at + CODEX_GAP_MS + 800; n += 400) watch(n, () => { t.tick(n); return t.takeRenotify() ? 'renotify' : undefined; });
    },
    osc9: (at: number) => watch(at, () => t.osc9()),
    esc: (at: number) => watch(at, () => { t.input(at, false); t.interrupt(at); }),
    env: (at: number) => watch(at, () => t.environment(at)),
    reply: (at: number) => watch(at, () => t.terminalReply(at)),
    /** Ticks every 400 ms like the app. */
    run: (from: number, to: number) => { for (let n = from; n <= to; n += 400) watch(n, () => { t.tick(n); return t.takeRenotify() ? 'renotify' : undefined; }); },
    /** Output every `every` ms between two instants, with the ticks of the app in between. */
    stream: (from: number, to: number, every = 500) => {
      for (let n = from; n <= to; n += every) { watch(n, () => t.output(n)); watch(n + 1, () => { t.tick(n + 1); return t.takeRenotify() ? 'renotify' : undefined; }); }
    },
  };
}

/** A finished first turn of an unhooked cell: submitted at 0, working until 6 s, silence-based waiting. */
function unhookedWaiting() {
  const c = cell();
  c.submit(0);
  c.stream(300, 6000);
  c.run(6000, 9000);
  return c;
}

describe('window visibility regression (minimize, restore 10 minutes later, redraw)', () => {
  const MINUTE = 60_000;

  /** Minimize at 1 min, nothing ticks for 10 minutes, restore: the window redraws every 500 ms for a few seconds. */
  function minimizeAndRestore(c: ReturnType<typeof cell>, redrawMs = 6000) {
    c.env(MINUTE); // visibilitychange / blur
    const restore = 11 * MINUTE;
    c.env(restore); // visibilitychange / focus
    c.reply(restore + 20); // focus-in report
    c.run(restore, restore); // the first tick after the throttled timers: a suspension gap
    for (let n = restore + 100; n <= restore + redrawMs; n += 500) {
      c.out(n);
      c.run(n + 1, n + 1);
    }
    c.run(restore + redrawMs + 400, restore + redrawMs + 30_000);
  }

  it('unhooked Codex cell: neither an alert nor a status flip', () => {
    const c = unhookedWaiting();
    expect(c.alerts).toEqual(['done']);
    const flips = c.flips.length;
    minimizeAndRestore(c);
    expect(c.t.status).toBe('waiting');
    expect(c.flips.length).toBe(flips);
    expect(c.alerts).toEqual(['done']);
  });

  it('hooked Codex cell: neither an alert nor a status flip', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 6000);
    c.end(6100, 'turn-1');
    expect(c.alerts).toEqual(['done']);
    expect(c.t.isHooked).toBe(true);
    const flips = c.flips.length;
    minimizeAndRestore(c, 6000);
    expect(c.t.status).toBe('waiting');
    expect(c.flips.length).toBe(flips);
    expect(c.alerts).toEqual(['done']);
  });

  it('a redraw that outlasts the quiet window may flip the status, but the same turn never alerts twice', () => {
    const c = unhookedWaiting();
    // no environment events at all: the redraw runs for 10 s straight (worst case), then the cell is quiet again
    for (let n = 700_000; n <= 710_000; n += 500) { c.out(n); c.run(n + 1, n + 1); }
    c.run(710_400, 725_000);
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done']);
  });

  it('a wake from sleep (a tick gap) counts as a window change', () => {
    const c = unhookedWaiting();
    c.run(10_000, 10_000);
    const woke = 10_000 + 3 * SUSPEND_MS;
    c.run(woke, woke); // first tick after the gap
    for (let n = woke + 100; n <= woke + 6000; n += 500) { c.out(n); c.run(n + 1, n + 1); }
    c.run(woke + 6400, woke + 20_000);
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done']);
  });

  it('real work right after the user submits is still recognized while the window was just restored', () => {
    const c = unhookedWaiting();
    c.env(100_000);
    c.submit(101_000);
    c.out(101_500);
    expect(c.t.status).toBe('working');
  });

  it('a genuinely working cell keeps working through a window change and alerts once when it ends', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 3000);
    c.env(3000);
    c.stream(3500, 9000);
    expect(c.t.status).toBe('working');
    c.end(9500, 'turn-1');
    expect(c.alerts).toEqual(['done']);
  });
});

describe('Codex notify drives the status', () => {
  it('alerts once per turn at the notify, not at a mid-turn pause', () => {
    const c = cell();
    c.end(-4000, 'turn-0'); // the hook works (first turn already reported)
    expect(c.alerts).toEqual(['done']);
    c.submit(1000);
    c.stream(1200, 4000);
    c.run(4000, 4000 + 5000); // a tool runs silently for 5 s: the heuristic alone would have said "waiting"
    expect(c.t.status).toBe('working');
    c.stream(10_000, 12_000);
    c.end(12_300, 'turn-1');
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done', 'done']);
    c.end(12_400, 'turn-1'); // the same turn reported again
    c.run(12_800, 40_000);
    expect(c.alerts).toEqual(['done', 'done']);
    expect(c.flips.map((f) => f.to)).toEqual(['waiting', 'idle', 'working', 'waiting']);
  });

  it('the first turn of a process still falls back to the heuristic until a notify arrives', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 3000);
    c.run(3000, 6000);
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done']);
    c.end(6500, 'turn-1'); // late notify of the same turn: nothing new
    expect(c.alerts).toEqual(['done']);
    expect(c.t.isHooked).toBe(true);
  });

  it('a lost notify is caught late by the silence net, once', () => {
    const c = cell();
    c.end(-4000, 'turn-0');
    c.submit(1000);
    c.stream(1200, 3000);
    c.run(3000, 3000 + CODEX_QUIET_MS - 400);
    expect(c.t.status).toBe('working');
    c.run(3000 + CODEX_QUIET_MS - 400, 3000 + CODEX_QUIET_MS + 1500);
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done', 'done']);
  });

  it('Esc on a hooked Codex cell ends the work quietly', () => {
    const c = cell();
    c.end(-4000, 'turn-0');
    c.submit(1000);
    c.stream(1200, 3000);
    c.esc(3100);
    c.run(3100, 9000);
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done']);
  });

  it('an approval prompt (OSC 9) is a precise "needs you", and the turn end still alerts once afterwards', () => {
    const c = cell();
    c.end(-4000, 'turn-0');
    c.submit(1000);
    c.stream(1200, 3000);
    c.osc9(3100);
    expect(c.t.status).toBe('waiting');
    expect(c.t.lastReason).toBe('attention');
    expect(c.alerts).toEqual(['done', 'attention']);
    c.run(3100, 30_000); // waiting for the user for a long time: nothing else happens
    expect(c.alerts).toEqual(['done', 'attention']);
    c.submit(31_000); // approves with Enter
    c.stream(31_200, 36_000);
    expect(c.t.status).toBe('working');
    c.end(36_300, 'turn-1');
    expect(c.alerts).toEqual(['done', 'attention', 'done']);
  });

  it('a message queued behind a finished turn alerts when its own turn ends, without a new Enter', () => {
    const c = cell();
    c.end(-4000, 'turn-0');
    c.stream(2000, 8000); // Codex starts the queued turn by itself: sustained output reopens the finished turn
    expect(c.t.status).toBe('working');
    c.end(8300, 'turn-1');
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done', 'done']);
    c.notify(12_000, 'turn-1'); // the same turn reported again
    c.run(12_400, 16_000);
    expect(c.alerts).toEqual(['done', 'done']);
  });

  it('an approval answered with a plain key still ends with a finished alert', () => {
    const c = cell();
    c.end(-4000, 'turn-0');
    c.submit(1000);
    c.stream(1200, 3000);
    c.osc9(3100);
    c.key(4000); // "y"
    c.stream(4100, 9000);
    expect(c.t.status).toBe('working'); // sustained output after the prompt: the work went on
    c.end(9300, 'turn-1');
    expect(c.alerts).toEqual(['done', 'attention', 'done']);
  });

  it('OSC 9 with no turn at all is ignored; after a finished turn an approval still raises attention', () => {
    const c = cell();
    c.osc9(0);
    expect(c.t.status).toBe('idle');
    c.end(1000, 'turn-1');
    expect(c.alerts).toEqual(['done']);
    c.osc9(5000); // a queued turn asks for an approval before any sustained output
    expect(c.t.lastReason).toBe('attention');
    expect(c.alerts).toEqual(['done', 'attention']);
  });

  it('an approval raises attention while working and while a finished turn is shown alike', () => {
    const working = cell();
    working.submit(0);
    working.stream(300, 2000);
    working.osc9(2100);
    expect(working.alerts).toEqual(['attention']);
    const finished = cell();
    finished.submit(0);
    finished.stream(300, 2000);
    finished.end(2100, 'turn-1');
    finished.osc9(6000);
    finished.osc9(6100); // a second prompt line of the same question: nothing new
    expect(finished.alerts).toEqual(['done', 'attention']);
  });

  it('a non-Codex cell keeps the old OSC 9 meaning (finished)', () => {
    const c = cell({ codex: false });
    c.submit(0);
    c.stream(300, 2000);
    c.osc9(2100);
    expect(c.t.status).toBe('waiting');
    expect(c.t.lastReason).toBe('done');
  });

  it('a restored, resumed cell shows nothing and alerts for nothing until a turn is observed', () => {
    const c = cell();
    c.out(0);
    c.run(0, 20_000);
    c.env(10_000);
    c.out(30_000);
    expect(c.flips).toEqual([]);
    expect(c.alerts).toEqual([]);
  });

  it('a restart (new process) forgets that the hook works, so the heuristic covers an old Codex without notify', () => {
    const c = cell();
    c.end(-4000, 'turn-0');
    expect(c.t.isHooked).toBe(true);
    c.t.reset();
    expect(c.t.isHooked).toBe(false);
    c.submit(1000);
    c.stream(1200, 3000);
    c.run(3000, 6000);
    expect(c.t.status).toBe('waiting');
  });

  it('reports automation "ready" for a precise Codex turn end', () => {
    expect(automationStatusFor('waiting', 'done', true, 'working')).toBe('ready');
    expect(automationStatusFor('waiting', 'attention', true, 'working')).toBe('needs_attention');
  });
});

describe('turn failures (usage limit)', () => {
  it('a Codex usage-limit line ends the turn as an error with its own alert', () => {
    const c = cell();
    c.end(-4000, 'turn-0');
    c.submit(1000);
    c.stream(1200, 3000);
    c.out(3200, LIMIT_LINE);
    c.run(3200, 3200 + FAILURE_QUIET_MS + 800);
    expect(c.t.status).toBe('waiting');
    expect(c.t.lastReason).toBe('error');
    expect(c.t.lastError).toBe('usage-limit');
    expect(c.alerts).toEqual(['done', 'error']);
    expect(failureLabel(c.t.lastError)).toBe('limit osiągnięty');
  });

  it('works on the first turn too (before any notify)', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 2000);
    c.out(2300, LIMIT_LINE);
    c.run(2300, 6000);
    expect(c.t.lastReason).toBe('error');
    expect(c.alerts).toEqual(['error']);
  });

  it('the next turn is a normal one again', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 1000);
    c.out(1300, LIMIT_LINE);
    c.run(1300, 5000);
    expect(c.t.lastReason).toBe('error');
    c.submit(10_000);
    c.stream(10_200, 13_000);
    c.end(13_300, 'turn-9');
    expect(c.t.lastReason).toBe('done');
    expect(c.t.lastError).toBeUndefined();
    expect(c.alerts).toEqual(['error', 'done']);
  });

  it('the same line printed with no turn in progress (replay of history, an idle screen) is not a failure', () => {
    const c = cell();
    c.out(0, LIMIT_LINE);
    c.run(0, 10_000);
    expect(c.flips).toEqual([]);
    c.end(11_000, 'turn-1');
    c.out(12_000, LIMIT_LINE); // already waiting: a redraw of the old error
    c.run(12_000, 20_000);
    expect(c.t.lastReason).toBe('done');
    expect(c.alerts).toEqual(['done']);
  });

  it('a failure noticed in the previous turn does not turn a later successful notify into an error', () => {
    const c = cell();
    c.submit(0);
    c.stream(100, 1500);
    c.out(1600, LIMIT_LINE);
    c.submit(1700); // the user submits again before the silence
    c.stream(1800, 3000);
    c.end(3100, 'turn-1');
    expect(c.t.lastReason).toBe('done');
  });

  it('a muted cell raises nothing but still shows the error', () => {
    const c = cell({ muted: true });
    c.submit(0);
    c.stream(300, 1000);
    c.out(1300, LIMIT_LINE);
    c.run(1300, 5000);
    expect(c.t.lastReason).toBe('error');
    expect(c.alerts).toEqual([]);
  });

  it('Claude StopFailure (rate limit) is an error with a limit label, other codes a plain error label', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('fail', 1000, { error: 'rate_limit' });
    expect(t.status).toBe('waiting');
    expect(t.lastReason).toBe('error');
    expect(t.lastError).toBe('rate_limit');
    expect(failureLabel('rate_limit')).toBe('limit osiągnięty');
    expect(failureLabel('server_error')).toBe('błąd');
    expect(failureLabel('billing_error')).toBe('błąd');
    expect(failureLabel(undefined)).toBe('błąd');
    expect(alertEventOf('hook', 'error')).toBe('error');
    t.hook('prompt', 5000);
    t.hook('stop', 6000);
    expect(t.lastError).toBeUndefined();
  });

  it('the limit codes and their phrases line up', () => {
    for (const code of LIMIT_ERRORS) expect(errorPhrase(code)).toBe('limit osiągnięty');
    expect(errorPhrase('overloaded')).not.toBe(errorPhrase('rate_limit'));
  });
});

describe('alerts: one per turn, mute', () => {
  it('dedupes finished and error alerts per cell and turn, never attention or turnless events', () => {
    const first = createTurnDedupe();
    expect(first('a', 'done', 's:1')).toBe(true);
    expect(first('a', 'done', 's:1')).toBe(false);
    expect(first('b', 'done', 's:1')).toBe(true);
    expect(first('a', 'error', 's:1')).toBe(true);
    expect(first('a', 'error', 's:1')).toBe(false);
    expect(first('a', 'done', 's:2')).toBe(true);
    expect(first('a', 'attention', 's:2')).toBe(true);
    expect(first('a', 'attention', 's:2')).toBe(true);
    expect(first('a', 'done', undefined)).toBe(true);
    expect(first('a', 'done', undefined)).toBe(true);
  });

  it('a Claude cell driven by hooks has no turn key, so a continued Stop still alerts again', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    expect(t.turnKey).toBeUndefined();
    t.hook('stop', 1000);
    t.hook('stop', 9000, { continuation: true });
    expect(t.turnKey).toBeUndefined();
  });

  it('honours the mute and the duplicate flag before anything is raised', () => {
    const ctx = { prev: 'working', status: 'waiting', cause: 'hook', hooked: true, reason: 'done', userLooking: false, agent: true, now: new Date(2026, 9, 12, 12) } as const;
    expect(decideAlert(defaultAlerts(), ctx)).toMatchObject({ event: 'done', notify: true });
    expect(decideAlert(defaultAlerts(), { ...ctx, muted: true })).toEqual({ event: 'done', notify: false, sound: null, suppressed: 'muted' });
    expect(decideAlert(defaultAlerts(), { ...ctx, duplicate: true })).toEqual({ event: 'done', notify: false, sound: null, suppressed: 'duplicate' });
    // a muted cell that was not a real transition is not reported as muted
    expect(decideAlert(defaultAlerts(), { ...ctx, prev: 'waiting', muted: true }).suppressed).toBeUndefined();
    expect(decideAlert(defaultAlerts(), { ...ctx, agent: false, muted: true }).suppressed).toBeUndefined();
    // muting wins over the error event as well
    expect(decideAlert(defaultAlerts(), { ...ctx, reason: 'error', muted: true })).toMatchObject({ event: 'error', suppressed: 'muted' });
  });

  it('keeps the quiet constants consistent', () => {
    expect(ENV_QUIET_MS).toBeGreaterThan(5000);
    expect(CODEX_QUIET_MS).toBeGreaterThan(4000);
  });
});

describe('per-cell mute', () => {
  it('is stored on the cell, survives a save, and un-muting removes the field', () => {
    let s = addProject(defaultState(), { name: 'bot', path: 'D:\Projekty\bot' });
    s = addTab(s, s.projects[0].id, { layout: layoutForCount(2), cells: [{ profileId: 'codex' }, { profileId: 'codex' }] });
    const [a, b] = s.projects[0].tabs[0].cells;
    s = updateCell(s, a.id, { muted: true });
    const reloaded = normalizeState(JSON.parse(JSON.stringify(s)))!;
    expect(findCell(reloaded, a.id)!.cell.muted).toBe(true);
    expect(findCell(reloaded, b.id)!.cell.muted).toBeUndefined();
    s = updateCell(s, a.id, { muted: undefined });
    expect('muted' in findCell(s, a.id)!.cell).toBe(false);
  });
});

const MAIN = '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091';
const OTHER = '0198aa11-2222-7333-8444-555566667777';
const SUB1 = '0198aa11-9999-7333-8444-555566667777';
const SUB2 = '0198aa11-aaaa-7333-8444-555566667777';

/** A cell with its thread bookkeeping: what the tracker asks the app to store as the cell's session. */
function threaded(session?: { id: string; confirmed?: boolean }) {
  const c = cell();
  const binds: Array<{ id: string; confirmed: boolean }> = [];
  c.t.onBind = (b) => binds.push(b);
  c.t.threads.begin(session);
  return { c, binds };
}

describe('sub-agent threads and the parent turn end', () => {
  it('a sub-agent notify while output goes on is no turn end, no alert and no binding; the parent end binds', () => {
    const { c, binds } = threaded();
    c.submit(0);
    c.stream(300, 3000);
    c.notify(3100, 'turn-sub', SUB1); // a sub-agent finished, the parent keeps working
    c.stream(3300, 8800);
    expect(c.t.status).toBe('working');
    expect(c.alerts).toEqual([]);
    expect(binds).toEqual([]);
    expect(c.t.threads.isSecondary(SUB1)).toBe(true);
    c.end(8900, 'turn-main', MAIN);
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done']);
    expect(binds).toEqual([{ id: MAIN, confirmed: false }]);
  });

  it('the commit waits for the quiet gap: no alert while the final repaint goes on, then the gap commits', () => {
    const { c } = threaded();
    c.submit(0);
    c.stream(300, 3000);
    c.notify(3100, 'turn-main', MAIN);
    c.out(3100 + 800); // the finished turn's last repaint
    c.run(3100, 3100 + 800 + CODEX_GAP_MS - 500);
    expect(c.t.status).toBe('working');
    expect(c.alerts).toEqual([]);
    c.run(3100 + 800 + CODEX_GAP_MS - 100, 3100 + 800 + CODEX_GAP_MS + 1000);
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done']);
  });

  it('a repaint burst of 1.5 s after the notify, then quiet, still commits (latency = repaint + gap)', () => {
    const { c, binds } = threaded();
    c.submit(0);
    c.stream(300, 3000);
    c.notify(3100, 'turn-main', MAIN);
    for (let n = 3200; n <= 4700; n += 300) { c.out(n); c.run(n + 1, n + 1); }
    expect(c.alerts).toEqual([]);
    c.run(4800, 4700 + CODEX_GAP_MS + 800);
    expect(c.t.status).toBe('waiting');
    expect(c.alerts).toEqual(['done']);
    expect(binds).toEqual([{ id: MAIN, confirmed: false }]);
  });

  it('a continuous spinner for 5 s after the notify is mid-turn: no alert, no binding, thread remembered as secondary', () => {
    const { c, binds } = threaded();
    c.submit(0);
    c.stream(300, 3000);
    c.notify(3100, 'turn-sub', SUB1);
    c.stream(3200, 8200, 400);
    c.run(8400, 12_000);
    expect(c.alerts).toEqual([]);
    expect(binds).toEqual([]);
    expect(c.t.threads.isSecondary(SUB1)).toBe(true);
    expect(c.t.status).toBe('working');
  });

  it('a gap that begins after the window is too late: the notify stays mid-turn', () => {
    const { c } = threaded();
    c.submit(0);
    c.stream(300, 3000);
    c.notify(3100, 'turn-x', SUB1);
    c.stream(3200, 3100 + CODEX_WINDOW_MS + 600, 400);
    c.run(3100 + CODEX_WINDOW_MS + 1000, 3100 + CODEX_WINDOW_MS + 4000);
    expect(c.alerts).toEqual([]);
    expect(c.t.threads.isSecondary(SUB1)).toBe(true);
  });

  it('a resumed process whose sub-agent finishes twice inside one parent turn keeps the stored session', () => {
    const { c, binds } = threaded({ id: MAIN, confirmed: true });
    c.submit(0);
    c.stream(300, 2000);
    c.notify(2100, 'turn-s1', SUB1);
    c.stream(2300, 5000);
    c.notify(5100, 'turn-s1b', SUB1); // the same sub-agent again: already known, ignored outright
    c.notify(5200, 'turn-s2', SUB2);
    c.stream(5300, 9000);
    expect(c.t.status).toBe('working');
    expect(c.alerts).toEqual([]);
    c.end(9100, 'turn-main', MAIN);
    expect(c.alerts).toEqual(['done']);
    expect(binds).toEqual([]);
    expect(c.t.threads.isSecondary(MAIN)).toBe(false);
  });

  it('a sub-agent thread is never bound even when it ends quietly later, and does not end the parent turn by itself', () => {
    const { c, binds } = threaded();
    c.submit(0);
    c.stream(300, 3000);
    c.notify(3100, 'turn-sub', SUB1);
    c.stream(3300, 5000);
    c.end(5100, 'turn-main', MAIN);
    expect(binds).toEqual([{ id: MAIN, confirmed: false }]);
    c.submit(20_000);
    c.stream(20_300, 24_000);
    c.end(24_100, 'turn-sub-2', SUB1);
    expect(binds).toEqual([{ id: MAIN, confirmed: false }]);
    expect(c.alerts).toEqual(['done']);
  });

  it('two notifies before either commits: the earlier was not the end', () => {
    const { c, binds } = threaded();
    c.submit(0);
    c.stream(300, 2000);
    c.notify(2100, 'turn-a', SUB1);
    c.notify(2300, 'turn-b', MAIN);
    c.run(2300, 6000);
    expect(c.alerts).toEqual(['done']);
    expect(binds).toEqual([{ id: MAIN, confirmed: false }]);
    expect(c.t.threads.isSecondary(SUB1)).toBe(true);
  });

  it('the same thread ending two turns confirms the session; a single report never does', () => {
    const { c, binds } = threaded();
    c.submit(0);
    c.stream(300, 2000);
    c.end(2100, 'turn-1', MAIN);
    expect(binds).toEqual([{ id: MAIN, confirmed: false }]);
    c.submit(20_000);
    c.stream(20_300, 22_000);
    c.end(22_100, 'turn-2', MAIN);
    expect(binds).toEqual([{ id: MAIN, confirmed: false }, { id: MAIN, confirmed: true }]);
  });

  it('two cells in one folder bind independently', () => {
    const one = threaded();
    const two = threaded();
    two.c.submit(0);
    two.c.stream(300, 2000);
    two.c.end(2100, 'turn-b', OTHER);
    one.c.submit(500);
    one.c.stream(800, 3000);
    one.c.end(3100, 'turn-a', MAIN);
    expect(one.binds).toEqual([{ id: MAIN, confirmed: false }]);
    expect(two.binds).toEqual([{ id: OTHER, confirmed: false }]);
  });

  it('a user submit before the quiet drops the pending notify without marking anything', () => {
    const { c, binds } = threaded();
    c.submit(0);
    c.stream(300, 2000);
    c.notify(2100, 'turn-1', MAIN);
    c.submit(2400);
    c.stream(2700, 5000);
    expect(c.t.status).toBe('working');
    expect(binds).toEqual([]);
    expect(c.t.threads.isSecondary(MAIN)).toBe(false);
  });
});

describe('failure line: revertible, anchored, per spawn', () => {
  it('sustained output after a failure end reverts the cell to working; the real turn end then alerts normally', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 1500);
    c.out(1800, LIMIT_LINE);
    c.run(1800, 4000);
    expect(c.t.status).toBe('waiting');
    expect(c.t.lastReason).toBe('error');
    expect(c.alerts).toEqual(['error']);
    c.stream(5000, 9000); // the agent goes on: the line was part of the turn (a retry), not its end
    expect(c.t.status).toBe('working');
    c.end(9300, 'turn-1', MAIN);
    expect(c.t.status).toBe('waiting');
    expect(c.t.lastReason).toBe('done');
    expect(c.t.lastError).toBeUndefined();
    expect(c.alerts).toEqual(['error', 'done']);
  });

  it('a little redraw right after the failure line does not revert it', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 1500);
    c.out(1800, LIMIT_LINE);
    c.run(1800, 4000);
    c.out(4500);
    c.out(5000);
    c.run(5000, 12_000);
    expect(c.t.lastReason).toBe('error');
    expect(c.t.status).toBe('waiting');
  });

  it('an rg result line that contains the limit text never starts an error', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 1500);
    c.out(1800, "test/codex-status.test.ts:16:const LIMIT_LINE = '\\x1b[31m■ You’ve hit your usage limit. Try again later.\\x1b[0m\\r\\n';\r\n");
    c.end(2200, 'turn-1', MAIN);
    expect(c.t.lastReason).toBe('done');
    expect(c.alerts).toEqual(['done']);
  });

  it('the same turn number in a restarted process alerts again (turn 1 limit, restart, turn 1 limit)', () => {
    const c = cell();
    c.submit(0);
    c.stream(300, 1500);
    c.out(1800, LIMIT_LINE);
    c.run(1800, 4000);
    expect(c.alerts).toEqual(['error']);
    c.t.reset(); // the cell restarts (prepareSpawn)
    c.t.setCodex(true);
    c.submit(10_000);
    c.stream(10_300, 11_500);
    c.out(11_800, LIMIT_LINE);
    c.run(11_800, 14_000);
    expect(c.t.lastReason).toBe('error');
    expect(c.alerts).toEqual(['error', 'error']);
  });

  it('keys of alerts differ per spawn and per reopened turn, and Claude hook cells still have none', () => {
    const t = new StatusTracker();
    t.setCodex(true);
    t.input(0, true);
    const first = t.turnKey;
    t.reset();
    t.setCodex(true);
    t.input(0, true);
    expect(t.turnKey).not.toBe(first);
    const claude = new StatusTracker();
    claude.hook('prompt', 0);
    expect(claude.turnKey).toBeUndefined();
  });
});
