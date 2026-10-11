import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAILURE_COOLDOWN_MS, isRecentFailure, parseFailure, runStartupGate, shouldGateOnStartup,
  type GateDeps, type GateEnv, type GateView,
} from '../src/main/startupGate';

const env: GateEnv = { platform: 'win32', packaged: true, portable: false, autoInstall: true, recentFailure: false };

describe('shouldGateOnStartup', () => {
  it('gates only the installed Windows build with automatic updates', () => {
    expect(shouldGateOnStartup(env)).toBe(true);
    expect(shouldGateOnStartup({ ...env, platform: 'darwin' })).toBe(false);
    expect(shouldGateOnStartup({ ...env, platform: 'linux' })).toBe(false);
    expect(shouldGateOnStartup({ ...env, packaged: false })).toBe(false);
    expect(shouldGateOnStartup({ ...env, portable: true })).toBe(false);
    expect(shouldGateOnStartup({ ...env, autoInstall: false })).toBe(false);
    expect(shouldGateOnStartup({ ...env, recentFailure: true })).toBe(false);
  });

  it('keeps a failure for the cooldown only and ignores malformed records', () => {
    expect(isRecentFailure({ version: '1.0.0', at: 1000 }, 1000 + FAILURE_COOLDOWN_MS - 1)).toBe(true);
    expect(isRecentFailure({ version: '1.0.0', at: 1000 }, 1000 + FAILURE_COOLDOWN_MS)).toBe(false);
    expect(isRecentFailure({ version: '1.0.0', at: 5000 }, 1000)).toBe(false);
    expect(isRecentFailure(undefined, 1000)).toBe(false);
    expect(parseFailure({ version: '1.0.0', at: 5 })).toEqual({ version: '1.0.0', at: 5 });
    expect(parseFailure({ version: 1, at: 5 })).toBeUndefined();
    expect(parseFailure(null)).toBeUndefined();
    expect(parseFailure({ version: '1', at: Number.NaN })).toBeUndefined();
  });
});

describe('runStartupGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (over: Partial<GateDeps> = {}) => {
    const views: GateView[] = [];
    const deps = {
      check: vi.fn(async () => undefined),
      abandonCheck: vi.fn(),
      download: vi.fn(async (progress: (p: number) => void) => { progress(50); }),
      show: vi.fn((view: GateView) => { views.push(view); }),
      hide: vi.fn(),
      handoff: vi.fn(async (_version: string, hide: () => void) => { hide(); return true; }),
      recordFailure: vi.fn(),
      ...over,
    } satisfies GateDeps;
    return { deps, views };
  };
  const delayed = <T,>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('starts the app without ever showing the window when there is no update quickly', async () => {
    const { deps } = make({ check: vi.fn(() => delayed(undefined, 100)) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe('start-app');
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.show).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('shows the checking window after the short delay and closes it when current', async () => {
    const { deps, views } = make({ check: vi.fn(() => delayed(undefined, 1500)) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBe('start-app');
    expect(views).toEqual([{ kind: 'checking' }]);
    expect(deps.hide).toHaveBeenCalledTimes(1);
  });

  it('fails open after the hard timeout when the server never answers', async () => {
    const { deps, views } = make({ check: vi.fn(() => new Promise<never>(() => {})) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(7999);
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('start-app');
    expect(deps.abandonCheck).toHaveBeenCalledTimes(1);
    expect(views).toEqual([{ kind: 'checking' }]);
    expect(deps.hide).toHaveBeenCalledTimes(1);
    expect(deps.recordFailure).not.toHaveBeenCalled();
  });

  it('fails open when the check rejects or throws synchronously', async () => {
    for (const check of [vi.fn(async () => { throw new Error('offline'); }), vi.fn(() => { throw new Error('boom'); })]) {
      const { deps } = make({ check: check as never });
      expect(await runStartupGate(deps)).toBe('start-app');
      expect(deps.download).not.toHaveBeenCalled();
    }
  });

  it('survives a window that fails to show or hide', async () => {
    const { deps } = make({ check: vi.fn(() => delayed(undefined, 1000)), show: vi.fn(() => { throw new Error('gpu'); }), hide: vi.fn(() => { throw new Error('gone'); }) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe('start-app');
  });

  it('downloads, reports progress and hands over to the installer without starting the app', async () => {
    const { deps, views } = make({ check: vi.fn(async () => ({ version: '2.0.0' })) });
    expect(await runStartupGate(deps)).toBe('installing');
    expect(views).toEqual([
      { kind: 'downloading', version: '2.0.0', percent: 0 },
      { kind: 'downloading', version: '2.0.0', percent: 50 },
      { kind: 'installing', version: '2.0.0' },
    ]);
    expect(deps.handoff).toHaveBeenCalledWith('2.0.0', expect.any(Function));
    expect(deps.hide).toHaveBeenCalledTimes(1);
    expect(deps.recordFailure).not.toHaveBeenCalled();
  });

  it('records the failure, shows it and starts the current version when the download fails', async () => {
    const { deps, views } = make({ check: vi.fn(async () => ({ version: '2.0.0' })), download: vi.fn(async () => { throw new Error('disk full'); }) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await result).toBe('start-app');
    expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
    expect(views.at(-1)).toEqual({ kind: 'failed', version: '2.0.0' });
    expect(deps.handoff).not.toHaveBeenCalled();
    expect(deps.hide).toHaveBeenCalledTimes(1);
  });

  it('records the failure and starts the app when the installer hand-over does not happen', async () => {
    const { deps } = make({ check: vi.fn(async () => ({ version: '2.0.0' })), handoff: vi.fn(async () => false) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await result).toBe('start-app');
    expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
  });

  it('treats a stalled download as a failure', async () => {
    const { deps } = make({ check: vi.fn(async () => ({ version: '2.0.0' })), download: vi.fn(() => new Promise<void>(() => {})) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(60_000 + 2500);
    expect(await result).toBe('start-app');
    expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
  });

  it('keeps a slow but progressing download alive', async () => {
    let progress!: (p: number) => void; let finish!: () => void;
    const { deps } = make({
      check: vi.fn(async () => ({ version: '2.0.0' })),
      download: vi.fn((onProgress: (p: number) => void) => new Promise<void>((resolve) => { progress = onProgress; finish = resolve; })),
    });
    const result = runStartupGate(deps);
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(40_000); progress(i * 10); }
    finish();
    expect(await result).toBe('installing');
    expect(deps.recordFailure).not.toHaveBeenCalled();
  });

  it('never retries a version that already failed', async () => {
    const { deps } = make({ check: vi.fn(async () => ({ version: '2.0.0' })), skipVersion: '2.0.0' });
    expect(await runStartupGate(deps)).toBe('start-app');
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.handoff).not.toHaveBeenCalled();
  });

  it('still updates to a newer version than the one that failed', async () => {
    const { deps } = make({ check: vi.fn(async () => ({ version: '2.0.1' })), skipVersion: '2.0.0' });
    expect(await runStartupGate(deps)).toBe('installing');
  });
});
