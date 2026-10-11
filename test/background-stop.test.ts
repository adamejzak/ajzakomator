import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { HookServer, hasActiveBackgroundWork, logStopDebug, parseSessionStart } from '../src/main/hooks';
import { BG_STALL_MS, INTERRUPT_QUIET_MS, shouldNotify, StatusTracker, STALL_MS } from '../src/shared/status';

/** Ticks every 5 s (like the app) so the sleep detection does not restart the silence window. */
const run = (t: StatusTracker, from: number, to: number) => { for (let n = from + 5000; n <= to; n += 5000) t.tick(n); return t.tick(to); };
const bg = (...tasks: unknown[]) => JSON.stringify({ background_tasks: tasks });

describe('hasActiveBackgroundWork', () => {
  it('handles the payload shapes', () => {
    expect(hasActiveBackgroundWork(bg())).toBe(false);
    expect(hasActiveBackgroundWork(bg({ id: 'a', status: 'running' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ status: 'completed' }, { status: 'Running' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ status: 'completed' }, { status: 'FAILED' }, { status: 'killed' }))).toBe(false);
    expect(hasActiveBackgroundWork(bg({ id: 'x' }))).toBe(true);
    expect(hasActiveBackgroundWork(bg({ status: 'weird' }))).toBe(true);
    expect(hasActiveBackgroundWork('not json')).toBe(false);
    expect(hasActiveBackgroundWork('null')).toBe(false);
    expect(hasActiveBackgroundWork('{}')).toBe(false);
    expect(hasActiveBackgroundWork(JSON.stringify({ background_tasks: 'x' }))).toBe(false);
    expect(hasActiveBackgroundWork(JSON.stringify({ session_crons: [{ id: 'c', status: 'active' }] }))).toBe(false);
  });
});

describe('hook server Stop', () => {
  it('emits stopbg or stop, rejects oversized and wrong-token requests', async () => {
    const s = new HookServer();
    await s.start();
    const seen: string[] = [];
    s.on('hook', (cell, ev) => seen.push(`${cell}:${ev}`));
    const url = (ev: string) => s.url('c1', ev as never);
    const post = (u: string, b: string) => fetch(u, { method: 'POST', body: b });
    await post(url('stop'), bg({ status: 'running' }));
    await post(url('stop'), bg({ status: 'done' }));
    await post(url('stop'), JSON.stringify({ last_assistant_message: 'y'.repeat(100_000) }));
    await post(url('stopbg'), bg({ status: 'running' }));
    await post(url('stop'), 'z'.repeat(600_000)).catch(() => {});
    await post(url('notify'), 'z'.repeat(20_000)).catch(() => {});
    await post(`http://127.0.0.1:${s.port}/h/bad/c1/stop/x`, bg({ status: 'running' })).catch(() => {});
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual(['c1:stopbg', 'c1:stop', 'c1:stop', 'c1:stop']); // the oversized Stop still counts as a plain Stop
    s.stop();
  });

  it('writes a Stop hook that posts its payload', async () => {
    const s = new HookServer();
    await s.start();
    const dir = mkdtempSync(join(tmpdir(), 'mc-bg-'));
    try {
      const json = JSON.parse(readFileSync(s.writeClaudeSettings(dir, 'c2'), 'utf8'));
      expect(json.hooks.Stop[0].hooks[0].command).toContain('--data-binary @-');
      expect(json.hooks.Stop[0].hooks[0].command).toContain('/c2/stop');
      expect(json.hooks.UserPromptSubmit[0].hooks[0].command).not.toContain('--data-binary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      s.stop();
    }
  });
});

describe('SessionStart hardening', () => {
  const id = '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091';
  it('ignores subagent payloads and accepts fork', () => {
    expect(parseSessionStart(JSON.stringify({ session_id: id, agent_id: 'sub1' }))).toBeNull();
    expect(parseSessionStart(JSON.stringify({ session_id: id, source: 'fork' }))).toEqual({ sessionId: id, source: 'fork' });
  });
});

describe('StatusTracker background work', () => {
  it('stays working past STALL_MS and flips only after BG_STALL_MS', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stopbg', 1000);
    expect(t.status).toBe('working');
    expect(run(t, 1000, 1000 + STALL_MS + 5000)).toBe('working');
    expect(run(t, 1000, 1000 + BG_STALL_MS - 5)).toBe('working');
    expect(t.tick(1000 + BG_STALL_MS)).toBe('waiting');
  });

  it('leaves background mode once the long net expired, so a later lost Stop uses the short net', () => {
    const t = new StatusTracker();
    t.hook('stopbg', 0);
    expect(t.tick(BG_STALL_MS)).toBe('waiting');
    t.hook('busy', BG_STALL_MS + 10);
    t.hook('prompt', BG_STALL_MS + 20);
    expect(run(t, BG_STALL_MS + 20, BG_STALL_MS + 20 + STALL_MS + 1000)).toBe('waiting');
  });

  it('ignores Esc while background work runs', () => {
    const t = new StatusTracker();
    t.hook('stopbg', 0);
    t.interrupt(1000);
    expect(t.tick(1000 + INTERRUPT_QUIET_MS + 10)).toBe('working');
    t.input(2000, false);
    expect(t.status).toBe('working');
  });

  it('busy keeps the flag; prompt, stop and notify clear it', () => {
    for (const ev of ['prompt', 'stop', 'notify'] as const) {
      const t = new StatusTracker();
      t.hook('stopbg', 0);
      t.hook('busy', 100);
      expect(t.tick(100 + STALL_MS + 1)).toBe('working');
      t.hook(ev, 200);
      t.hook('prompt', 300);
      expect(t.tick(300 + STALL_MS)).toBe('waiting');
    }
    const t = new StatusTracker();
    t.hook('stopbg', 0);
    t.hook('stop', 10);
    expect(t.status).toBe('waiting');
    t.hook('prompt', 20);
    expect(t.tick(20 + STALL_MS)).toBe('waiting');
  });

  it('reset and exit clear the flag', () => {
    const t = new StatusTracker();
    t.hook('stopbg', 0);
    t.reset();
    t.hook('prompt', 10);
    expect(t.tick(10 + STALL_MS)).toBe('waiting');
  });

  it('does not notify for stopbg, then notifies on the real stop', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    let prev = t.status;
    t.hook('stopbg', 100);
    expect(shouldNotify(prev, t.status, t.lastCause)).toBe(false);
    prev = t.status;
    t.hook('prompt', 200);
    expect(shouldNotify(prev, t.status, t.lastCause)).toBe(false);
    prev = t.status;
    t.hook('stop', 300);
    expect(shouldNotify(prev, t.status, t.lastCause)).toBe(true);
  });
});

describe('Stop debug log', () => {
  it('writes only keys, types and statuses, and is silent when disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-dbg-'));
    try {
      const body = JSON.stringify({
        last_assistant_message: 'SECRET-MSG',
        background_tasks: [{ id: 'i1', type: 'subagent', status: 'running', description: 'SECRET-DESC', command: 'SECRET-CMD' }],
      });
      logStopDebug(false, dir, 'c1', body);
      expect(existsSync(join(dir, 'hook-debug.log'))).toBe(false);
      logStopDebug(true, dir, 'c1', body);
      const log = readFileSync(join(dir, 'hook-debug.log'), 'utf8');
      expect(log).toContain('c1');
      expect(log).toContain('last_assistant_message,background_tasks');
      expect(log).toContain('subagent/running');
      expect(log).not.toContain('SECRET');
      for (let i = 0; i < 3000; i++) logStopDebug(true, dir, 'c1', body);
      expect(readFileSync(join(dir, 'hook-debug.log'), 'utf8').length).toBeLessThan(300 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
