import { describe, expect, it } from 'vitest';
import { INTERRUPT_QUIET_MS, isUserInput, shouldNotify, STALL_MS, StatusTracker } from '../src/shared/status';

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
    t.hook('prompt', 0);
    t.hook('stop', 0);
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
    expect(isUserInput('\x1bP')).toBe(true); // Alt+Shift+P
    expect(isUserInput('\x1b]')).toBe(true); // Alt+]
    expect(isUserInput('\x1b[200~pasted\nline\x1b[201~')).toBe(true);
    expect(isUserInput('\x1b]10;rgb:0000/0000/0000\x07')).toBe(false);
    expect(isUserInput('\x1bP1$r0m\x1b\\')).toBe(false);
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
});

describe('Claude hooks', () => {
  it('permission answer (Enter after a notification) goes back to working', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('notify', 0);
    expect(t.status).toBe('waiting');
    t.input(5, true);
    expect(t.status).toBe('working');
  });

  it('Enter on an idle prompt after Stop waits for UserPromptSubmit instead', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stop', 0);
    t.input(5, true);
    expect(t.status).toBe('waiting');
    t.hook('prompt', 0);
    expect(t.status).toBe('working');
  });

  it('tool / subagent activity brings a background-mode waiting back to working', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stopbg', 0); // background task: the turn "ended" but the agent resumes without a new prompt
    t.hook('busy', 0);
    expect(t.status).toBe('working');
  });

  it('a plain Stop closes the turn: late tool / subagent hooks do not reopen it', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('stop', 0);
    t.hook('busy', 0);
    expect(t.status).toBe('waiting');
    t.hook('prompt', 10);
    expect(t.status).toBe('working');
  });
});

describe('safety nets and review fixes', () => {
  it('a hooked cell whose Stop never arrives falls back to waiting after STALL_MS of silence', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.output(1000);
    expect(t.tick(1000 + STALL_MS - 1)).toBe('working');
    expect(t.tick(1000 + STALL_MS)).toBe('waiting');
    expect(t.lastCause).toBe('heuristic');
    expect(shouldNotify('working', 'waiting', t.lastCause)).toBe(true); // a non-hooked cell would alert...
    expect(shouldNotify('working', 'waiting', t.lastCause, true)).toBe(false); // ...a hooked one is judged by its hooks only
  });

  it('a spinner keeps a hooked cell working past STALL_MS', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    for (let ms = 1000; ms <= 120_000; ms += 1000) { t.output(ms); t.tick(ms); }
    expect(t.status).toBe('working');
  });

  it('Esc / Ctrl-C on a working hooked cell returns to waiting after a short silence', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.output(1000);
    t.interrupt(2000);
    expect(t.tick(2000 + INTERRUPT_QUIET_MS - 1)).toBe('working');
    expect(t.tick(2000 + INTERRUPT_QUIET_MS)).toBe('waiting');
  });

  it('output after Esc (the agent ignored it) keeps the cell working', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.interrupt(1000);
    for (let ms = 1500; ms <= 9000; ms += 500) { t.output(ms); t.tick(ms); }
    expect(t.status).toBe('working');
  });

  it('interrupt is ignored when the cell is not working', () => {
    const t = new StatusTracker();
    t.hook('stop', 0);
    t.interrupt(1);
    expect(t.tick(100_000)).toBe('waiting');
  });

  it('a heuristic waiting recovers when the hooked agent keeps redrawing', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.tick(STALL_MS + 1);
    expect(t.status).toBe('waiting');
    for (let ms = STALL_MS + 2000; ms <= STALL_MS + 8000; ms += 1000) t.output(ms);
    expect(t.status).toBe('working');
  });

  it('hooks that never arrive: the heuristic still works for a Claude cell', () => {
    const t = new StatusTracker(1000);
    t.input(0, true);
    t.output(500);
    expect(t.tick(600)).toBe('working');
    expect(t.tick(2000)).toBe('waiting');
    expect(t.lastCause).toBe('heuristic');
  });

  it('...but a resumed Claude cell without any hook still does not turn waiting on its own', () => {
    const t = new StatusTracker(1000);
    for (let ms = 0; ms <= 8000; ms += 500) t.output(ms);
    t.osc9();
    expect(t.tick(20_000)).toBe('idle');
  });

  it('any real key (not only Enter) answers a permission prompt', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('notify', 10);
    t.input(20, false); // "n" / digit / Esc
    expect(t.status).toBe('working');
    expect(t.tick(20 + STALL_MS)).toBe('waiting'); // nothing followed: silence net
  });

  it('typing after Stop does not clear a plain waiting', () => {
    const t = new StatusTracker();
    t.hook('stop', 0);
    t.input(5, false);
    expect(t.status).toBe('waiting');
  });

  it('a busy hook from a parallel tool does not hide a pending permission prompt', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('notify', 1);
    t.hook('busy', 2);
    expect(t.status).toBe('waiting');
    t.input(3, false);
    t.hook('busy', 4);
    expect(t.status).toBe('working');
  });

  it('a lone Esc after a denied prompt leads back to waiting', () => {
    const t = new StatusTracker();
    t.hook('prompt', 0);
    t.hook('notify', 1000);
    t.input(2000, false);
    t.interrupt(2000);
    expect(t.status).toBe('working');
    expect(t.tick(2000 + INTERRUPT_QUIET_MS)).toBe('waiting');
  });
});
