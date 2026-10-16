import { describe, expect, it } from 'vitest';
import { WORKFLOW_STALL_MS } from '../src/shared/status';
import { matchesBackgroundWait, screenHoldsStop, screenWaitsForBackground, WAIT_ROWS, type WaitBuffer } from '../src/shared/backgroundWait';

const buffer = (lines: string[], baseY = 0): WaitBuffer => ({ baseY, getLine: (i) => (i < lines.length ? { translateToString: () => lines[i] } : undefined) });

describe('matchesBackgroundWait', () => {
  it('accepts Claude Code footers', () => {
    for (const line of ['* Waiting for 1 dynamic workflow to finish', '  ⎿ Waiting for 3 dynamic workflows to finish', 'Waiting for 2 background agents', '✻ Waiting for 1 task to finish']) {
      expect(matchesBackgroundWait(line)).toBe(true);
    }
  });
  it('rejects prose and other waits', () => {
    for (const line of ['Waiting for you', 'The workflow is waiting for review', 'I am waiting for 2 tasks to finish', 'waiting for 1 dynamic workflow']) {
      expect(matchesBackgroundWait(line)).toBe(false);
    }
  });
});

describe('screenWaitsForBackground', () => {
  it('looks at the bottom rows of the screen only', () => {
    const rows = 24;
    const lines = Array.from({ length: 100 }, () => '');
    lines[100 - 3] = '* Waiting for 1 dynamic workflow to finish';
    expect(screenWaitsForBackground(buffer(lines, 100 - rows), rows)).toBe(true);
    const old = Array.from({ length: 100 }, () => '');
    old[100 - rows - 1] = '* Waiting for 1 dynamic workflow to finish'; // scrolled away
    expect(screenWaitsForBackground(buffer(old, 100 - rows), rows)).toBe(false);
    const high = Array.from({ length: 100 }, () => '');
    high[100 - rows + 2] = '* Waiting for 1 dynamic workflow to finish'; // on screen but above the bottom WAIT_ROWS
    expect(WAIT_ROWS).toBe(8);
    expect(screenWaitsForBackground(buffer(high, 100 - rows), rows)).toBe(false);
  });
});

describe('screenHoldsStop', () => {
  const base = { agent: true, codex: false, workflows: 0, backgroundMs: 0, screenWaits: () => true };

  it('holds a Claude Stop without workflows while the screen shows the wait line', () => {
    expect(screenHoldsStop(base)).toBe(true);
    expect(screenHoldsStop({ ...base, workflows: undefined })).toBe(true);
    expect(screenHoldsStop({ ...base, backgroundMs: WORKFLOW_STALL_MS - 1 })).toBe(true);
  });

  it('never holds a shell / SSH cell, a Codex cell, a Stop that names workflows, a screen without the line, or after the cap', () => {
    expect(screenHoldsStop({ ...base, agent: false })).toBe(false);
    expect(screenHoldsStop({ ...base, codex: true })).toBe(false);
    expect(screenHoldsStop({ ...base, workflows: 2 })).toBe(false);
    expect(screenHoldsStop({ ...base, screenWaits: () => false })).toBe(false);
    expect(screenHoldsStop({ ...base, backgroundMs: WORKFLOW_STALL_MS })).toBe(false);
  });

  it('reads the screen only when everything else allows the hold', () => {
    let reads = 0;
    const screenWaits = () => { reads++; return true; };
    screenHoldsStop({ ...base, agent: false, screenWaits });
    screenHoldsStop({ ...base, backgroundMs: WORKFLOW_STALL_MS, screenWaits });
    expect(reads).toBe(0);
  });
});
