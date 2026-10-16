import { describe, expect, it } from 'vitest';
import { matchesBackgroundWait, screenWaitsForBackground, WAIT_ROWS, type WaitBuffer } from '../src/shared/backgroundWait';

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
