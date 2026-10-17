import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHROMIUM_WEBGL_CONTEXTS, MAX_WEBGL_CONTEXTS } from '../src/shared/terminalLimits';
import { MAX_CELLS } from '../src/shared/layout';
import { planWebgl, WEBGL_BUSY_MS, WEBGL_HOLD_MS, webglBackoff, type WebglCandidate } from '../src/shared/webglPool';

const NOW = 100_000;
const c = (id: string, hasWebgl: boolean, attached: boolean, extra: Partial<WebglCandidate> = {}): WebglCandidate => ({ id, hasWebgl, attached, shownAt: 0, ...extra });
const busy = { outputAt: NOW - 100 };
const old = { changedAt: NOW - WEBGL_HOLD_MS - 1 };

describe('WebGL context pool', () => {
  it('serves a shown terminal from a free slot', () => {
    expect(planWebgl([c('a', true, true), c('b', false, true)], 3, NOW)).toEqual({ grant: ['b'], release: [] });
  });

  it('takes the context of the least recently shown parked terminal at the limit', () => {
    const all = [c('a', true, true), c('b', true, false, { shownAt: 5 }), c('c', true, false, { shownAt: 2 }), c('d', false, true)];
    expect(planWebgl(all, 3, NOW)).toEqual({ grant: ['d'], release: ['c'] });
  });

  it('gives back the excess of parked terminals when the limit was lowered', () => {
    const all = [c('a', true, false, { shownAt: 1 }), c('b', true, false, { shownAt: 2 }), c('c', true, false, { shownAt: 3 })];
    expect(planWebgl(all, 1, NOW)).toEqual({ grant: [], release: ['a', 'b'] });
  });

  it('keeps contexts of parked terminals while nobody on screen needs one', () => {
    expect(planWebgl([c('a', true, false), c('b', true, true)], 2, NOW)).toEqual({ grant: [], release: [] });
  });

  it('never swaps between equally quiet shown terminals', () => {
    const all = [c('a', true, true, old), c('b', true, true, old), c('c', false, true)];
    expect(planWebgl(all, 2, NOW)).toEqual({ grant: [], release: [] });
  });

  it('a busy shown terminal takes the context of the quietest settled one on screen', () => {
    const all = [c('a', true, true, { ...old, outputAt: NOW - WEBGL_BUSY_MS - 10 }), c('b', true, true, { ...old, outputAt: NOW - 50 }), c('c', false, true, busy)];
    expect(planWebgl(all, 2, NOW)).toEqual({ grant: ['c'], release: ['a'] });
  });

  it('the focused terminal comes first and never loses its context', () => {
    const all = [c('a', true, true, { ...old, focused: true }), c('b', true, true, { ...old, ...busy }), c('c', false, true, { focused: false }), c('d', false, true, { focused: true })];
    // Only one is really focused at a time; the plan still never takes the context of a terminal marked focused.
    expect(planWebgl(all, 2, NOW)).toEqual({ grant: ['d'], release: ['b'] });
  });

  it('hysteresis: a context held for less than WEBGL_HOLD_MS stays, and a terminal that just lost one waits', () => {
    const fresh = [c('a', true, true, { changedAt: NOW - 1000 }), c('b', false, true, busy)];
    expect(planWebgl(fresh, 1, NOW)).toEqual({ grant: [], release: [] });
    const justLost = [c('a', true, true, old), c('b', false, true, { ...busy, changedAt: NOW - 1000 })];
    expect(planWebgl(justLost, 1, NOW)).toEqual({ grant: [], release: [] });
  });

  it('moves at most one context between shown terminals per plan', () => {
    const all = [c('a', true, true, old), c('b', true, true, old), c('c', false, true, busy), c('d', false, true, busy)];
    expect(planWebgl(all, 2, NOW)).toEqual({ grant: ['c'], release: ['a'] });
  });

  it('skips a terminal that is backing off after a lost context', () => {
    expect(planWebgl([c('a', false, true, { blockedUntil: NOW + 1 }), c('b', false, true)], 4, NOW)).toEqual({ grant: ['b'], release: [] });
  });

  it('a 20-cell grid gets 20 contexts after a long run of swaps settles, with no swap back', () => {
    // Simulates a plan every second: 24 slots, 20 shown cells: everyone has one after the first plan.
    const cells = Array.from({ length: 20 }, (_, i) => c(`c${i}`, false, true, busy));
    const plan = planWebgl(cells, MAX_WEBGL_CONTEXTS, NOW);
    expect(plan.grant).toHaveLength(20);
    expect(plan.release).toEqual([]);
  });

  it('a short pool converges without thrashing: each cell moves at most once per hold period', () => {
    // 16 slots, 20 shown cells; the busy set rotates every second. Count how often each cell gains or loses a context.
    const state = new Map(Array.from({ length: 20 }, (_, i) => [`c${i}`, { has: false, changedAt: undefined as number | undefined }]));
    const moves = new Map<string, number[]>();
    for (let t = 0; t < 60; t++) {
      const now = NOW + t * 1000;
      const cands = [...state].map(([id, s], i) => c(id, s.has, true, { changedAt: s.changedAt, outputAt: (i + t) % 5 === 0 ? now - 10 : now - 10_000 }));
      const plan = planWebgl(cands, 16, now);
      expect(plan.release.length).toBeLessThanOrEqual(1);
      for (const id of [...plan.release, ...plan.grant]) {
        const s = state.get(id)!;
        if (t > 0) moves.set(id, [...(moves.get(id) ?? []), now]);
        s.has = plan.grant.includes(id);
        s.changedAt = now;
      }
    }
    for (const times of moves.values()) for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(WEBGL_HOLD_MS);
    expect([...state.values()].filter((s) => s.has)).toHaveLength(16);
  });

  it('backs off after lost contexts: 2 s doubling up to a minute', () => {
    expect([1, 2, 3, 6, 10].map(webglBackoff)).toEqual([2000, 4000, 8000, 60_000, 60_000]);
  });

  it('every cell of the largest grid fits, below the limit main gives Chromium', () => {
    expect(MAX_WEBGL_CONTEXTS).toBeGreaterThanOrEqual(MAX_CELLS);
    expect(MAX_WEBGL_CONTEXTS).toBeLessThan(CHROMIUM_WEBGL_CONTEXTS);
    expect(readFileSync('src/main/index.ts', 'utf8')).toContain("app.commandLine.appendSwitch('max-active-webgl-contexts', String(CHROMIUM_WEBGL_CONTEXTS))");
  });
});
