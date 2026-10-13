import { describe, expect, it } from 'vitest';
import {
  countMouseEchoes, MOUSE_ECHO_FLOOD_PER_SECOND, INPUT_MODE_PARAMS, INPUT_MODES_OFF, isMouseReport, MOUSE_ECHO_PROOF, MOUSE_FLOOD_PER_SECOND, MouseFloodGuard, resetTail, terminalModeReset,
} from '../src/shared/termReset';

describe('mode reset sequences', () => {
  it('switches off mouse, focus, paste and kitty keyboard modes and nothing else', () => {
    expect(INPUT_MODE_PARAMS).toEqual([1000, 1002, 1003, 1005, 1006, 1015, 1004, 2004]);
    expect(INPUT_MODES_OFF).toBe('\x1b[?1000;1002;1003;1005;1006;1015;1004;2004l\x1b[<u');
  });
  it('the manual reset keeps the buffer and leaves the alternate screen only when needed', () => {
    expect(terminalModeReset(false)).not.toContain('1049');
    expect(terminalModeReset(true)).toContain('\x1b[?1049l');
    for (const reset of [terminalModeReset(false), terminalModeReset(true)]) {
      expect(reset).toContain(INPUT_MODES_OFF);
      expect(reset).not.toMatch(/\x1b\[[23]J|\x1bc/); // no erase of scrollback, no RIS
      expect(reset).not.toContain('9001');
    }
  });
  it('tails per shell write the escape character through the shell, not literally', () => {
    expect(resetTail('pwsh')).toBe(resetTail('powershell'));
    expect(resetTail('pwsh')).toBe("; [Console]::Write([char]27+'[?1000;1002;1003;1005;1006;1015;1004;2004l'+[char]27+'[<u')");
    expect(resetTail('cmd')).toBe(` & powershell -NoProfile -NonInteractive -Command "[Console]::Write([char]27+'[?1000;1002;1003;1005;1006;1015;1004;2004l'+[char]27+'[<u')" 2>nul`);
    expect(resetTail('zsh')).toBe(resetTail('bash'));
    expect(resetTail('bash')).toBe("; printf '\\033[?1000;1002;1003;1005;1006;1015;1004;2004l\\033[<u'");
    for (const shell of ['pwsh', 'powershell', 'cmd', 'zsh', 'bash'] as const) expect(resetTail(shell)).not.toMatch(/[\x00-\x1f]/);
  });
});

describe('mouse report detection', () => {
  it('recognises SGR and X10 reports only', () => {
    for (const r of ['\x1b[<35;12;6M', '\x1b[<0;12;6m', '\x1b[M !!']) expect(isMouseReport(r)).toBe(true);
    for (const r of ['\x1b[I', '\x1b[A', 'a', '\x1b[<35;12;6Mx', '\x1b']) expect(isMouseReport(r)).toBe(false);
  });
  it('counts printed echoes, including the ones PSReadLine coloured or mangled, but not real sequences', () => {
    expect(countMouseEchoes('^[[<35;12;6M^[[<35;13;6M')).toBe(2);
    expect(countMouseEchoes('\x1b[5;32H\x1b[93m[555\x1b[37m;\x1b[97m12\x1b[37m;\x1b[93m6M\x1b[39;49m')).toBe(1);
    expect(countMouseEchoes('\x1b[<35;12;6M plain text [1;2] ls -l')).toBe(0);
  });
});

describe('MouseFloodGuard', () => {
  const burst = (g: MouseFloodGuard, from: number, n: number, gone: boolean, step = 10) => {
    const dropped: boolean[] = [];
    for (let i = 0; i < n; i++) dropped.push(g.report(from + i * step, gone));
    return dropped;
  };

  it('never trips on a busy TUI that tracks the mouse (rate alone is not proof)', () => {
    const g = new MouseFloodGuard();
    expect(burst(g, 1000, 500, false, 8).some(Boolean)).toBe(false);
    expect(g.tripped).toBe(false);
  });
  it('trips once the CLI is gone and more than the limit arrives within a second', () => {
    const g = new MouseFloodGuard();
    const dropped = burst(g, 1000, MOUSE_FLOOD_PER_SECOND + 5, true, 10);
    expect(dropped.slice(0, MOUSE_FLOOD_PER_SECOND)).not.toContain(true);
    expect(dropped[MOUSE_FLOOD_PER_SECOND]).toBe(true);
    expect(g.tripped).toBe(true);
    expect(g.report(5000, false)).toBe(true); // stays muted until reset
    g.reset();
    expect(g.report(6000, true)).toBe(false);
  });
  it('trips on printed echoes of the reports, whatever the status says', () => {
    const g = new MouseFloodGuard();
    burst(g, 1000, 30, false, 10);
    for (let i = 0; i < MOUSE_ECHO_PROOF; i++) g.output(1300 + i, `^[[<35;${i};6M`);
    const dropped = burst(g, 1310, 20, false, 10);
    expect(dropped.some(Boolean)).toBe(true);
    expect(g.tripped).toBe(true);
    // proof of an echo lowers the limit, but still needs a real burst
    const slow = new MouseFloodGuard();
    burst(slow, 0, MOUSE_ECHO_FLOOD_PER_SECOND - 5, false, 20);
    for (let i = 0; i < MOUSE_ECHO_PROOF; i++) slow.output(400 + i, '^[[<35;1;1M');
    expect(burst(slow, 410, 4, false, 20).some(Boolean)).toBe(false);
  });
  it('slow reports (clicks, a few hovers) never trip, and old reports expire', () => {
    const g = new MouseFloodGuard();
    expect(burst(g, 0, 200, true, 100).some(Boolean)).toBe(false); // 10 per second
    const h = new MouseFloodGuard();
    burst(h, 0, 30, true, 10);
    expect(burst(h, 10_000, 30, true, 10).some(Boolean)).toBe(false);
  });
  it('only scans output while reports are being sent', () => {
    const g = new MouseFloodGuard();
    expect(g.watching(0)).toBe(false);
    g.report(0, false);
    expect(g.watching(500)).toBe(true);
    expect(g.watching(5000)).toBe(false);
    for (let i = 0; i < 10; i++) g.output(5000, '[<1;2;3M'); // not watching: ignored
    burst(g, 5001, 60, false, 5);
    expect(g.tripped).toBe(false);
  });
});
