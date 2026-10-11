import { describe, expect, it } from 'vitest';
import { StatusTracker, type CellStatus } from '../src/shared/status';

// The tracker only sees output timing, never the bytes, so how the pty output is split into chunks (escape
// sequences or wide characters cut in half, one big coalesced chunk) must not change any decision.

type Step = { at: number; do: 'input' | 'output' | 'osc9' | 'hook-prompt' | 'hook-stop' };

function run(steps: Step[], end: number, outputsPerBurst: number): CellStatus[] {
  const t = new StatusTracker();
  const timeline: CellStatus[] = [];
  let i = 0;
  for (let now = 0; now <= end; now += 100) {
    while (i < steps.length && steps[i].at <= now) {
      const s = steps[i++];
      if (s.do === 'input') t.input(s.at, true);
      else if (s.do === 'output') for (let k = 0; k < outputsPerBurst; k++) t.output(s.at);
      else if (s.do === 'osc9') t.osc9();
      else if (s.do === 'hook-prompt') t.hook('prompt', s.at);
      else t.hook('stop', s.at);
    }
    t.tick(now);
    timeline.push(t.status);
  }
  return timeline;
}

// Claude-like turn: spinner redraws every 100 ms for 4 s after Enter, then silence.
const heuristicTurn: Step[] = [
  { at: 0, do: 'input' },
  ...Array.from({ length: 40 }, (_, k): Step => ({ at: 400 + k * 100, do: 'output' })),
];
// Codex-like turn: the same, finished by an OSC 9 notification.
const codexTurn: Step[] = [...heuristicTurn, { at: 4600, do: 'osc9' }];
// Hooked Claude turn: precise events with output in between.
const hookedTurn: Step[] = [
  { at: 0, do: 'input' },
  { at: 100, do: 'hook-prompt' },
  ...Array.from({ length: 20 }, (_, k): Step => ({ at: 300 + k * 100, do: 'output' })),
  { at: 2600, do: 'hook-stop' },
];

describe('status decisions do not depend on output chunking', () => {
  for (const [name, steps] of [['heuristic', heuristicTurn], ['codex osc9', codexTurn], ['claude hooks', hookedTurn]] as const) {
    it(`${name}: 1, 3 and 50 chunks per burst give the same timeline`, () => {
      const one = run(steps, 9000, 1);
      expect(run(steps, 9000, 3)).toEqual(one);
      expect(run(steps, 9000, 50)).toEqual(one);
    });
  }

  it('detects working during the turn and waiting after it for both agent styles', () => {
    for (const steps of [heuristicTurn, codexTurn, hookedTurn]) {
      const tl = run(steps, 9000, 1);
      expect(tl[20]).toBe('working'); // 2 s in
      expect(tl.at(-1)).toBe('waiting');
    }
  });
});
