import { describe, expect, it } from 'vitest';
import { isUserInput, shouldNotify, StatusTracker } from '../src/shared/status';

describe('restart / session gating', () => {
  it('startup output of a resumed agent never turns into waiting (no turn observed)', () => {
    const t = new StatusTracker(1000);
    for (let ms = 0; ms <= 8000; ms += 500) t.output(ms);
    expect(t.tick(8100)).toBe('idle');
    expect(t.tick(20000)).toBe('idle');
  });

  it('a bell/OSC 9 before the user submitted anything is ignored', () => {
    const t = new StatusTracker();
    t.osc9();
    expect(t.status).toBe('idle');
  });

  it('notifies only for a real working -> waiting transition or a live hook', () => {
    expect(shouldNotify('working', 'waiting', 'heuristic')).toBe(true);
    expect(shouldNotify('idle', 'waiting', 'heuristic')).toBe(false);
    expect(shouldNotify('idle', 'waiting', 'hook')).toBe(true);
    expect(shouldNotify('waiting', 'waiting', 'hook')).toBe(false);
    expect(shouldNotify('working', 'idle', 'heuristic')).toBe(false);
    expect(shouldNotify('working', 'exited', 'heuristic')).toBe(false);
  });

  it('records the cause of the last transition', () => {
    const t = new StatusTracker(10);
    t.input(0, true);
    t.output(500);
    t.tick(1000);
    expect(t.status).toBe('waiting');
    expect(t.lastCause).toBe('heuristic');
    t.hook('prompt');
    t.hook('stop');
    expect(t.lastCause).toBe('hook');
  });

  it('a long suspend (sleep) does not turn a working cell into waiting', () => {
    const t = new StatusTracker(1000);
    t.input(0, true);
    t.output(500);
    expect(t.tick(600)).toBe('working');
    expect(t.tick(600 + 3600_000)).toBe('working');
  });
});

describe('input handling', () => {
  it('terminal-generated replies are not user input', () => {
    expect(isUserInput('\x1b[I')).toBe(false);
    expect(isUserInput('\x1b[O')).toBe(false);
    expect(isUserInput('\x1b[12;40R')).toBe(false);
    expect(isUserInput('\x1b[?1;2c')).toBe(false);
    expect(isUserInput('\x1b[<0;10;5M')).toBe(false);
    expect(isUserInput('a')).toBe(true);
    expect(isUserInput('\r')).toBe(true);
    expect(isUserInput('\x1b[A')).toBe(true);
  });

  it('typing does not clear waiting, submitting does (heuristic cells)', () => {
    const t = new StatusTracker(10);
    t.input(0, true);
    t.output(500);
    t.tick(1000);
    expect(t.status).toBe('waiting');
    t.input(2000, false);
    expect(t.status).toBe('waiting');
    t.input(2100, true);
    expect(t.status).toBe('idle');
  });

  it('keystrokes while the agent is working keep it working (echo window does not hide the spinner)', () => {
    const t = new StatusTracker(1500);
    t.input(0, true);
    t.output(500);
    expect(t.tick(600)).toBe('working');
    for (let ms = 700; ms <= 6000; ms += 100) {
      t.input(ms, false); // fast typing, spinner redraws land inside the echo window
      t.output(ms + 50);
    }
    expect(t.tick(6100)).toBe('working');
  });

  it('hooked working cell stays working while typing', () => {
    const t = new StatusTracker(10);
    t.hook('prompt');
    t.input(1, false);
    expect(t.status).toBe('working');
  });
});

describe('Claude hooks', () => {
  it('permission answer (Enter after a notification) goes back to working', () => {
    const t = new StatusTracker();
    t.hook('prompt');
    t.hook('notify');
    expect(t.status).toBe('waiting');
    t.input(5, true);
    expect(t.status).toBe('working');
  });

  it('Enter on an idle prompt after Stop waits for UserPromptSubmit instead', () => {
    const t = new StatusTracker();
    t.hook('prompt');
    t.hook('stop');
    t.input(5, true);
    expect(t.status).toBe('waiting');
    t.hook('prompt');
    expect(t.status).toBe('working');
  });

  it('tool / subagent activity brings a stale waiting back to working', () => {
    const t = new StatusTracker();
    t.hook('prompt');
    t.hook('stop'); // background task: turn "ended" but the agent resumes without a new prompt
    t.hook('busy');
    expect(t.status).toBe('working');
  });

  it('precise-hook cells ignore heuristics from the very first byte', () => {
    const t = new StatusTracker(1000, true);
    t.input(0, true);
    for (let ms = 100; ms <= 5000; ms += 500) t.output(ms);
    t.osc9();
    expect(t.tick(60000)).toBe('idle');
    t.reset();
    t.input(0, true);
    t.output(500);
    expect(t.tick(60000)).toBe('idle');
  });
});
