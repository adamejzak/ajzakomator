import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { HookServer, hasActiveBackgroundWork, stopInfo } from '../src/main/hooks';
import {
  ANSWER_GRACE_MS, BG_STALL_MS, END_GRACE_MS, INTERRUPT_QUIET_MS, isFocusOrMouseReport, isUserInput, shouldNotify, StatusTracker,
  type CellStatus, type HookEvent, type HookInfo, type StatusCause, WORKFLOW_STALL_MS,
} from '../src/shared/status';

/** Replays a timeline against one tracker and records every status change plus whether the app would alert for it. */
function sim() {
  const t = new StatusTracker();
  const changes: Array<{ at: number; from: CellStatus; to: CellStatus; cause: StatusCause; alert: boolean }> = [];
  const results: string[] = [];
  const watch = (at: number, change: () => string | void) => {
    const prev = t.status;
    const r = change();
    if (r) results.push(r);
    if (t.status !== prev) changes.push({ at, from: prev, to: t.status, cause: t.lastCause, alert: shouldNotify(prev, t.status, t.lastCause, t.isHooked) });
    else if (r === 'renotify') changes.push({ at, from: 'working', to: t.status, cause: t.lastCause, alert: shouldNotify('working', t.status, t.lastCause, t.isHooked) });
  };
  return {
    t, changes, results,
    alerts: () => changes.filter((c) => c.alert).length,
    hook: (at: number, ev: HookEvent, info?: HookInfo) => watch(at, () => t.hook(ev, at, info)),
    input: (at: number, submitted = false) => watch(at, () => { t.input(at, submitted); }),
    /** Ticks every 400 ms like the app. */
    run: (from: number, to: number) => { for (let n = from; n <= to; n += 400) watch(n, () => { t.tick(n); }); },
  };
}
const bg = (...tasks: unknown[]) => JSON.stringify({ background_tasks: tasks });

describe('Stop hooks that continue the turn (P1)', () => {
  it('a continuation after a Stop reopens the turn once the grace window passed; the real Stop alerts', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(2000, 'busy');
    s.hook(5000, 'busy');
    s.hook(10_000, 'stop'); // our curl fired, then a user Stop hook (decision: block) made Claude go on
    expect(s.t.status).toBe('waiting');
    s.hook(11_000, 'busy'); // inside the grace window: a late sibling of the Stop
    expect(s.t.status).toBe('waiting');
    s.run(11_000, 19_000);
    s.hook(20_000, 'busy'); // PreToolUse of the continuation
    expect(s.t.status).toBe('working');
    for (let at = 30_000; at <= 50_000; at += 10_000) { s.run(at - 10_000, at); s.hook(at, 'busy'); }
    s.run(50_000, 60_000);
    expect(s.t.status).toBe('working');
    s.hook(61_000, 'stop');
    expect(s.t.status).toBe('waiting');
    expect(s.changes.map((c) => `${c.from}->${c.to}:${c.alert}`)).toEqual(['idle->working:false', 'working->waiting:true', 'waiting->working:false', 'working->waiting:true']);
    expect(s.alerts()).toBe(2);
  });

  it('the grace window is END_GRACE_MS (3 s) after the Stop', () => {
    expect(END_GRACE_MS).toBe(3000);
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stop', 10_000);
    expect(t.hook('busy', 10_000 + END_GRACE_MS - 1)).toBe('ignored');
    expect(t.hook('busy', 10_000 + END_GRACE_MS)).toBe('applied');
    expect(t.status).toBe('working');
  });

  it('the same holds after StopFailure', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('fail', 1000);
    expect(t.hook('busy', 2000)).toBe('ignored');
    expect(t.hook('busy', 9000)).toBe('applied');
    expect(t.status).toBe('working');
  });

  it('SubagentStop never reopens a closed turn, however late (background subagents finish minutes later)', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(10_000, 'stop');
    for (const at of [10_100, 20_000, 120_000, 600_000]) s.hook(at, 'busy', { subagent: true });
    s.run(10_000, 700_000);
    expect(s.t.status).toBe('waiting');
    expect(s.changes.map((c) => c.to)).toEqual(['working', 'waiting']);
  });

  it('SubagentStop still counts while the turn is open or background work runs', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stopbg', 100);
    t.hook('busy', 60_000, { subagent: true });
    expect(t.status).toBe('working');
    const u = new StatusTracker();
    u.hook('prompt', 0);
    u.hook('busy', 500, { subagent: true });
    expect(u.status).toBe('working');
  });

  it('a tool hook that reopened the turn ends it again with an alert at the real Stop, not before', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stop');
    s.hook(9000, 'busy');
    s.run(9000, 20_000);
    expect(s.t.status).toBe('working');
    expect(s.alerts()).toBe(1);
    s.hook(21_000, 'stop');
    expect(s.alerts()).toBe(2);
  });

  it('stop_hook_active: the final Stop of a continued turn alerts again even when no tool hook came in between', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(10_000, 'stop', { tasks: 0, active: 0, statuses: [] });
    s.hook(13_000, 'stop', { tasks: 0, active: 0, statuses: [], continuation: true });
    expect(s.results).toEqual(['applied', 'applied', 'renotify']);
    expect(s.alerts()).toBe(2);
    // a continuation Stop that is the first Stop of the turn is an ordinary alert
    const t = new StatusTracker();
    t.hook('prompt', 0);
    expect(t.hook('stop', 100, { continuation: true })).toBe('applied');
  });

  it('stopInfo reads stop_hook_active', () => {
    expect(stopInfo(JSON.stringify({ stop_hook_active: true })).continuation).toBe(true);
    expect(stopInfo(JSON.stringify({ stop_hook_active: false })).continuation).toBe(false);
    expect(stopInfo(JSON.stringify({ stop_hook_active: 'yes' })).continuation).toBe(false);
    expect(stopInfo('garbage').continuation).toBe(false);
  });
});

describe('long shell-type background tasks do not hold the cell (P2)', () => {
  it('only agent-like or unknown task types hold it', () => {
    expect(hasActiveBackgroundWork(bg({ id: 'a', type: 'local_bash', status: 'running' }))).toBe(false);
    expect(hasActiveBackgroundWork(bg({ type: 'shell', status: 'running' }))).toBe(false);
    expect(hasActiveBackgroundWork(bg({ type: 'Monitor', status: 'running' }))).toBe(false);
    expect(hasActiveBackgroundWork(bg({ type: 'dev-server', status: 'running' }))).toBe(false);
    expect(hasActiveBackgroundWork(bg({ type: 'process', status: 'running' }))).toBe(false);
    expect(hasActiveBackgroundWork(bg({ type: 'command', status: 'running' }))).toBe(false);
    expect(hasActiveBackgroundWork(bg({ type: 'local_agent', status: 'running' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ type: 'subagent', status: 'running' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ type: 'workflow', status: 'running' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ type: 'task', status: 'running' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ status: 'running' }))).toBe(true); // missing type: conservative
    expect(hasActiveBackgroundWork(bg({ type: 'mystery', status: 'running' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ type: 'shell', status: 'running' }, { type: 'agent', status: 'running' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ type: 'agent', status: 'completed' }, { type: 'shell', status: 'running' }))).toBe(false);
  });

  it('stopInfo counts only the holding tasks as active and lists the types', () => {
    const info = stopInfo(bg({ id: 'SECRET', type: 'local_bash', status: 'running', command: 'SECRET-CMD' }, { type: 'local_agent', status: 'running' }, { type: 'local_agent', status: 'completed' }));
    expect(info).toEqual({ tasks: 3, active: 1, statuses: ['running', 'completed'], types: ['local_bash', 'local_agent'], continuation: false, workflows: 0 });
    expect(JSON.stringify(info)).not.toContain('SECRET');
  });

  it('the hook server emits a plain stop for a dev server task and stopbg for an agent task', async () => {
    const s = new HookServer();
    await s.start();
    const seen: string[] = [];
    s.on('hook', (_c, ev) => seen.push(ev));
    await fetch(s.url('c1', 'stop'), { method: 'POST', body: bg({ type: 'local_bash', status: 'running' }) });
    await fetch(s.url('c1', 'stop'), { method: 'POST', body: bg({ type: 'local_agent', status: 'running' }) });
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual(['stop', 'stopbg']);
    s.stop();
  });

  it('replay: two full turns with a dev server running in the background alert at every Stop', () => {
    const s = sim();
    const shellStop = bg({ type: 'local_bash', status: 'running', command: 'npm run dev' });
    for (const base of [0, 120_000]) {
      s.hook(base, 'prompt');
      s.hook(base + 5000, 'busy');
      // what the server derives from the payload
      s.hook(base + 20_000, hasActiveBackgroundWork(shellStop) ? 'stopbg' : 'stop', stopInfo(shellStop));
      expect(s.t.status).toBe('waiting');
    }
    s.run(240_000, 240_000 + BG_STALL_MS + 1000);
    expect(s.alerts()).toBe(2);
    expect(s.changes.map((c) => `${c.from}->${c.to}`)).toEqual(['idle->working', 'working->waiting', 'waiting->working', 'working->waiting']);
  });
});

describe('background net expiry alerts once (late but never missing)', () => {
  it('an agent task that never reports back ends waiting with reason done and one alert', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stopbg', { tasks: 1, active: 1, statuses: ['running'], types: ['local_agent'] });
    s.run(1000, 1000 + BG_STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastReason).toBe('done');
    expect(s.t.lastStallKind).toBe('bg');
    expect(s.alerts()).toBe(1);
    // output after the alert does not flip it back (hooks own the status)
    s.t.output(1000 + BG_STALL_MS + 5000);
    expect(s.t.status).toBe('waiting');
  });

  it('the plain 30 s stall and the SessionStart-ended background mode stay silent', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.run(0, 40_000);
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(0);
    const u = sim();
    u.hook(0, 'prompt');
    u.hook(1000, 'stopbg');
    u.hook(5000, 'session', { source: 'resume' });
    expect(u.alerts()).toBe(0);
  });
});

describe('a lost UserPromptSubmit heals (P3)', () => {
  it('turn 2 never reports its prompt: a tool hook reopens the turn and its Stop alerts', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(5000, 'stop'); // turn 1
    // user submits turn 2, the prompt curl is lost
    s.input(15_000, true);
    s.run(5000, 22_000 - 1);
    expect(s.t.status).toBe('waiting');
    s.hook(22_000, 'busy');
    expect(s.t.status).toBe('working');
    s.hook(35_000, 'busy');
    s.run(35_000, 49_000);
    s.hook(50_000, 'stop');
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(2);
  });
});

describe('a late permission notification after the user answered (P4)', () => {
  it('is ignored within ANSWER_GRACE_MS, a later one is a new prompt', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('notify', 1000);
    t.input(2000, false); // answer
    expect(t.status).toBe('working');
    expect(t.hook('notify', 2000 + ANSWER_GRACE_MS - 1)).toBe('ignored');
    expect(t.status).toBe('working');
    t.hook('busy', 2700);
    expect(t.hook('notify', 2000 + ANSWER_GRACE_MS)).toBe('applied');
    expect(t.status).toBe('waiting');
    expect(t.lastReason).toBe('attention');
  });

  it('plain typing while the agent works does not hide a real permission prompt', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.input(5000, false);
    expect(t.hook('notify', 5100)).toBe('applied');
    expect(t.status).toBe('waiting');
  });

  it('a submitted line while working shields only the next 600 ms', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.input(5000, true);
    expect(t.hook('notify', 5300)).toBe('ignored');
    expect(t.hook('notify', 5700)).toBe('applied');
  });
});

describe('only focus and mouse reports are terminal replies that mute output (P6)', () => {
  it('classifies the sequences', () => {
    for (const d of ['\x1b[I', '\x1b[O', '\x1b[<0;12;4M', '\x1b[<64;1;1m', '\x1b[M !!']) expect(isFocusOrMouseReport(d), JSON.stringify(d)).toBe(true);
    for (const d of ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[0n', '\x1b]10;rgb:0000/0000/0000\x07', '\x1bP1$r0m\x1b\\', 'a', '\r', '\x1b[A']) expect(isFocusOrMouseReport(d), JSON.stringify(d)).toBe(false);
    // everything it matches is also not user input
    for (const d of ['\x1b[I', '\x1b[<0;12;4M', '\x1b[M !!']) expect(isUserInput(d)).toBe(false);
  });

  it('an agent that queries the cursor position keeps its output counted', () => {
    const h = new StatusTracker(1500);
    h.input(0, true);
    h.output(500);
    expect(h.tick(600)).toBe('working');
    // CPR replies are not recorded via terminalReply (the manager only forwards focus / mouse reports), so output counts
    for (let ms = 1000; ms <= 4000; ms += 500) h.output(ms);
    expect(h.tick(4100)).toBe('working');
  });
});

describe('SubagentStop hook wiring', () => {
  it('has its own URL event and arrives as a subagent busy hook', async () => {
    const s = new HookServer();
    await s.start();
    const dir = mkdtempSync(join(tmpdir(), 'mc-sub-'));
    try {
      const json = JSON.parse(readFileSync(s.writeClaudeSettings(dir, 'c4'), 'utf8'));
      expect(json.hooks.SubagentStop[0].hooks[0].command).toContain('/c4/subagent/');
      expect(json.hooks.PostToolUse[0].hooks[0].command).toContain('/c4/busy/');
      const seen: Array<[string, HookInfo | undefined]> = [];
      s.on('hook', (_c, ev, info) => seen.push([ev, info]));
      await fetch(s.url('c4', 'subagent'), { method: 'POST', body: '{}' });
      await fetch(s.url('c4', 'busy'), { method: 'POST', body: '{}' });
      await new Promise((r) => setTimeout(r, 80));
      expect(seen).toEqual([['busy', { subagent: true }], ['busy', undefined]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      s.stop();
    }
  });
});

describe('a dynamic workflow keeps the cell working (W2)', () => {
  const start = (s: ReturnType<typeof sim>) => { s.hook(0, 'prompt'); s.hook(500, 'busy'); s.hook(1000, 'stopbg', { tasks: 1, active: 1, workflows: 1 }); };

  it('stays working for 3 h of sparse repaints without any hook, and never alerts', () => {
    const s = sim();
    start(s);
    for (let at = 1000; at < 3 * 3_600_000; at += 600_000) { s.run(at, at + 599_600); s.t.output(at + 600_000); }
    expect(s.t.status).toBe('working');
    expect(s.alerts()).toBe(0);
  });

  it('stays working through 3 h of complete silence', () => {
    const s = sim();
    start(s);
    s.run(1000, 1000 + 3 * 3_600_000);
    expect(s.t.status).toBe('working');
    expect(s.alerts()).toBe(0);
  });

  it('a plain background task (no workflow) still ends at BG_STALL_MS with one alert', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stopbg', { tasks: 1, active: 1, workflows: 0 });
    s.run(1000, 1000 + BG_STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastStallKind).toBe('bg');
    expect(s.alerts()).toBe(1);
  });

  it('the self-started turn after the workflow ends with exactly one alert', () => {
    const s = sim();
    start(s);
    s.run(1000, 2 * 3_600_000);
    s.hook(2 * 3_600_000 + 10, 'prompt');
    s.hook(2 * 3_600_000 + 2000, 'busy');
    s.hook(2 * 3_600_000 + 9000, 'stop', { tasks: 0, active: 0, workflows: 0 });
    expect(s.t.status).toBe('waiting');
    expect(s.alerts()).toBe(1);
  });

  it('ends silently on SessionStart (resume), with attention on notify and as an error on fail', () => {
    const resumed = sim();
    start(resumed);
    resumed.hook(60_000, 'session', { source: 'resume' });
    expect(resumed.t.status).toBe('waiting');
    expect(resumed.alerts()).toBe(0);
    const asked = sim();
    start(asked);
    asked.hook(60_000, 'notify');
    expect(asked.t.lastReason).toBe('attention');
    expect(asked.alerts()).toBe(1);
    const failed = sim();
    start(failed);
    failed.hook(60_000, 'fail', { error: 'rate_limit' });
    expect(failed.t.lastReason).toBe('error');
    expect(failed.alerts()).toBe(1);
  });

  it('the 6 h net ends a forgotten workflow silently', () => {
    const s = sim();
    start(s);
    s.run(1000, 1000 + WORKFLOW_STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastStallKind).toBe('workflow');
    expect(s.alerts()).toBe(0);
  });

  it('bgGuard true at the deadline keeps working and restarts the window; false lets the net act', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.hook(1000, 'stopbg', { tasks: 1, active: 1 });
    let showing = true;
    s.t.bgGuard = () => showing;
    s.run(1000, 1000 + BG_STALL_MS + 5000);
    expect(s.t.status).toBe('working');
    showing = false;
    s.run(1000 + BG_STALL_MS + 5000, 1000 + 2 * BG_STALL_MS + 10_000);
    expect(s.t.status).toBe('waiting');
  });

  it('a stopbg converted by the screen veto stays working while the screen still shows the wait', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.t.bgGuard = () => true;
    s.hook(1000, 'stopbg', { tasks: 0, active: 0, workflows: 0, screenWait: true });
    s.run(1000, 1000 + BG_STALL_MS * 3);
    expect(s.t.status).toBe('working');
  });

  it('a screen-converted stop keeps the short net: once the footer is gone it ends at BG_STALL_MS with one alert', () => {
    const s = sim();
    s.hook(0, 'prompt');
    s.t.bgGuard = () => false; // a leftover footer that is gone by the deadline
    s.hook(1000, 'stopbg', { tasks: 0, active: 0, workflows: 0, screenWait: true });
    s.run(1000, 1000 + BG_STALL_MS + 1000);
    expect(s.t.status).toBe('waiting');
    expect(s.t.lastStallKind).toBe('bg');
    expect(s.alerts()).toBe(1);
  });

  it('Esc during a workflow wait is ignored', () => {
    const s = sim();
    start(s);
    s.t.interrupt(5000);
    s.run(5000, 5000 + INTERRUPT_QUIET_MS + 1000);
    expect(s.t.status).toBe('working');
  });
});
