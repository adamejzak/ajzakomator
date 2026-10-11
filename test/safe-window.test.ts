import { describe, expect, it, vi } from 'vitest';
import { decideUncaught, isLive, safeSend, SHUTDOWN_HARD_LIMIT_MS, withLiveWindow } from '../src/main/safeWindow';

const fakeWindow = (state: { win?: boolean; contents?: boolean } = {}) => {
  const send = vi.fn((_channel: string, ..._args: unknown[]) => {
    if (state.contents) throw new Error('Object has been destroyed');
  });
  return { win: { isDestroyed: () => !!state.win, webContents: { isDestroyed: () => !!state.contents, send } }, send };
};

describe('safeSend', () => {
  it('delivers to a live window', () => {
    const { win, send } = fakeWindow();
    expect(safeSend(win, 'update:state', 1, 2)).toBe(true);
    expect(send).toHaveBeenCalledWith('update:state', 1, 2);
  });

  it('does nothing, without throwing, for a destroyed window, destroyed contents or no window', () => {
    for (const state of [{ win: true }, { contents: true }, { win: true, contents: true }]) {
      const { win, send } = fakeWindow(state);
      expect(safeSend(win, 'x')).toBe(false);
      expect(send).not.toHaveBeenCalled();
    }
    expect(safeSend(null, 'x')).toBe(false);
    expect(safeSend(undefined, 'x')).toBe(false);
  });

  it('swallows a send that throws after the liveness check passed', () => {
    const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => { throw new Error('Object has been destroyed'); } } };
    expect(safeSend(win, 'x')).toBe(false);
  });
});

describe('isLive and withLiveWindow', () => {
  it('reports liveness and runs the action only for live windows', () => {
    expect(isLive(fakeWindow().win)).toBe(true);
    expect(isLive(fakeWindow({ win: true }).win)).toBe(false);
    const action = vi.fn(() => 'ok');
    expect(withLiveWindow({ isDestroyed: () => false }, action)).toBe('ok');
    expect(withLiveWindow({ isDestroyed: () => true }, action)).toBeUndefined();
    expect(withLiveWindow(null, action)).toBeUndefined();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing action on a window that dies mid-way into undefined', () => {
    expect(withLiveWindow({ isDestroyed: () => false }, () => { throw new Error('Object has been destroyed'); })).toBeUndefined();
  });
});

describe('decideUncaught', () => {
  it('only logs "Object has been destroyed" in any phase', () => {
    expect(decideUncaught(new TypeError('Object has been destroyed'), 'running')).toBe('log');
    expect(decideUncaught(new TypeError('Object has been destroyed'), 'shutdown')).toBe('log');
  });

  it('keeps showing real errors in normal operation but never opens a dialog while shutting down', () => {
    expect(decideUncaught(new Error('boom'), 'running')).toBe('show');
    expect(decideUncaught('boom', 'running')).toBe('show');
    expect(decideUncaught(new Error('boom'), 'shutdown')).toBe('log');
  });

  it('leaves the wind-down a bounded time', () => {
    expect(SHUTDOWN_HARD_LIMIT_MS).toBeGreaterThan(10_000);
    expect(SHUTDOWN_HARD_LIMIT_MS).toBeLessThanOrEqual(30_000);
  });
});
