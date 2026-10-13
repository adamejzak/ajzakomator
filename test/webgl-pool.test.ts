import { describe, expect, it } from 'vitest';
import { planWebglSlot, type WebglCandidate } from '../src/shared/webglPool';

const c = (id: string, hasWebgl: boolean, attached: boolean, shownAt = 0): WebglCandidate => ({ id, hasWebgl, attached, shownAt });

describe('WebGL context pool', () => {
  it('allows a context while under the limit', () => {
    expect(planWebglSlot([c('a', true, true), c('b', false, false)], 3)).toEqual({ allowed: true, release: [] });
  });

  it('releases the least recently shown parked terminal at the limit', () => {
    const all = [c('a', true, true, 9), c('b', true, false, 5), c('c', true, false, 2), c('d', false, false)];
    expect(planWebglSlot(all, 3)).toEqual({ allowed: true, release: ['c'] });
  });

  it('releases several when the limit was lowered', () => {
    const all = [c('a', true, false, 1), c('b', true, false, 2), c('c', true, false, 3)];
    expect(planWebglSlot(all, 2)).toEqual({ allowed: true, release: ['a', 'b'] });
  });

  it('never takes a context from a terminal that is on screen: the newcomer uses the DOM renderer', () => {
    const all = [c('a', true, true), c('b', true, true), c('c', false, false)];
    expect(planWebglSlot(all, 2)).toEqual({ allowed: false, release: [] });
  });
});
