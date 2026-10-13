import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAILURE_COOLDOWN_MS, compareVersions, isActiveFailure, isRecentFailure, parseFailure, runStartupGate, shouldGateOnStartup,
  type GateDeps, type GateEnv, type GateView,
} from '../src/main/startupGate';

const env: GateEnv = { platform: 'win32', packaged: true, portable: false, mode: 'ask', recentFailure: false };

describe('shouldGateOnStartup', () => {
  it('gates only the installed Windows and macOS builds in the Automatic (ask) mode', () => {
    expect(shouldGateOnStartup(env)).toBe(true);
    expect(shouldGateOnStartup({ ...env, platform: 'darwin' })).toBe(true);
    expect(shouldGateOnStartup({ ...env, platform: 'darwin', mode: 'manual' })).toBe(false);
    expect(shouldGateOnStartup({ ...env, platform: 'darwin', packaged: false })).toBe(false);
    expect(shouldGateOnStartup({ ...env, platform: 'linux' })).toBe(false);
    expect(shouldGateOnStartup({ ...env, packaged: false })).toBe(false);
    expect(shouldGateOnStartup({ ...env, portable: true })).toBe(false);
    expect(shouldGateOnStartup({ ...env, mode: 'manual' })).toBe(false);
    expect(shouldGateOnStartup({ ...env, recentFailure: true })).toBe(false);
  });

  it('compares dotted versions numerically', () => {
    expect(compareVersions('0.5.9', '0.5.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.6', '0.6.0')).toBe(0);
    expect(compareVersions('0.6.0-beta.1', '0.6.0')).toBe(0);
  });

  it('a record of the version that is now running is no failure (the next start may offer a newer release)', () => {
    const record = { version: '0.5.98', at: 1000 };
    expect(isActiveFailure(record, '0.5.97', 2000)).toBe(true);
    expect(isActiveFailure(record, '0.5.98', 2000)).toBe(false);
    expect(isActiveFailure(record, '0.5.99', 2000)).toBe(false);
    expect(isActiveFailure(record, '0.5.97', 1000 + FAILURE_COOLDOWN_MS)).toBe(false);
    expect(isActiveFailure(undefined, '0.5.97', 2000)).toBe(false);
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
      // By default the user answers "Install now" at once; the ask-mode tests below answer by hand.
      onInstall: (install: () => void) => { install(); },
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

  it('closes a checking window the moment the answer arrives, without holding it on screen', async () => {
    const { deps, views } = make({ check: vi.fn(() => delayed(undefined, 900)) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(900);
    expect(await result).toBe('start-app');
    expect(views).toEqual([{ kind: 'checking' }]);
    expect(deps.hide).toHaveBeenCalledTimes(1);
  });

  it('returns at once when the user closes the checking window', async () => {
    let cancel!: () => void;
    const { deps } = make({ check: vi.fn(() => new Promise<never>(() => {})), onCancel: (cb) => { cancel = cb; } });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(850);
    cancel();
    expect(await result).toBe('start-app');
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
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toBe('start-app');
  });

  it('offers the update, downloads and hands over to the installer without starting the app', async () => {
    const { deps, views } = make({ check: vi.fn(async () => ({ version: '2.0.0' })) });
    expect(await runStartupGate(deps)).toBe('installing');
    expect(views).toEqual([{ kind: 'ask', version: '2.0.0' }, { kind: 'installing', version: '2.0.0' }]);
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
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(40_000); progress(i * 10); }
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

  it('marks the attempt before the installer starts, so an installer failing outside the app is remembered', async () => {
    const order: string[] = [];
    const { deps } = make({
      check: vi.fn(async () => ({ version: '2.0.0' })),
      markAttempt: vi.fn(() => { order.push('mark'); }),
      handoff: vi.fn(async () => { order.push('handoff'); return true; }),
    });
    expect(await runStartupGate(deps)).toBe('installing');
    expect(order).toEqual(['mark', 'handoff']);
    expect(deps.recordFailure).not.toHaveBeenCalled();
  });

  it('starts the app and records a failure when the hand-over never answers', async () => {
    const { deps } = make({ check: vi.fn(async () => ({ version: '2.0.0' })), handoff: vi.fn(() => new Promise<boolean>(() => {})) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(20_000 + 2500);
    expect(await result).toBe('start-app');
    expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
  });

  it('starts the app when the hand-over throws or reports that nothing was handed over', async () => {
    const { deps } = make({ check: vi.fn(async () => ({ version: '2.0.0' })), handoff: vi.fn(async () => { throw new Error('spawn'); }) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await result).toBe('start-app');
    expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
  });

  it('gives up on a download that keeps progressing but never finishes', async () => {
    let progress!: (p: number) => void;
    const { deps } = make({
      check: vi.fn(async () => ({ version: '2.0.0' })),
      download: vi.fn((onProgress: (p: number) => void) => new Promise<void>(() => { progress = onProgress; })),
    });
    const result = runStartupGate(deps);
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(40_000); progress(i); }
    await vi.advanceTimersByTimeAsync(2500);
    expect(await result).toBe('start-app');
    expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
    expect(deps.handoff).not.toHaveBeenCalled();
  });

  it('abandons the check only on a timeout, not on an ordinary failure', async () => {
    const { deps } = make({ check: vi.fn(async () => { throw new Error('offline'); }) });
    await runStartupGate(deps);
    expect(deps.abandonCheck).not.toHaveBeenCalled();
  });

  it('closes the window even when showing it threw', async () => {
    const { deps } = make({ check: vi.fn(() => delayed(undefined, 1000)), show: vi.fn(() => { throw new Error('gpu'); }) });
    const result = runStartupGate(deps);
    await vi.advanceTimersByTimeAsync(1100);
    await result;
    expect(deps.hide).toHaveBeenCalledTimes(1);
  });

  it('survives a failing attempt marker', async () => {
    const { deps } = make({ check: vi.fn(async () => ({ version: '2.0.0' })), markAttempt: vi.fn(() => { throw new Error('read-only'); }) });
    expect(await runStartupGate(deps)).toBe('installing');
  });

  describe('cancelled by the user', () => {
    const withCancel = (over: Partial<GateDeps> = {}) => {
      let cancel = () => {};
      const made = make({ onCancel: (callback: () => void) => { cancel = callback; }, ...over });
      return { ...made, cancel: () => cancel() };
    };

    it('starts the app during the check without recording a failure and abandons the check', async () => {
      const { deps, cancel } = withCancel({ check: vi.fn(() => new Promise<never>(() => {})), showAfterMs: 0 });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      cancel();
      expect(await result).toBe('start-app');
      expect(deps.abandonCheck).toHaveBeenCalled();
      expect(deps.recordFailure).not.toHaveBeenCalled();
      expect(deps.hide).toHaveBeenCalledTimes(1);
    });

    it('starts the app during the download, leaves the window closed and ignores later progress', async () => {
      let progress: (p: number) => void = () => {};
      const { deps, views, cancel } = withCancel({
        check: vi.fn(async () => ({ version: '2.0.0' })),
        download: vi.fn((report: (p: number) => void) => { progress = report; return new Promise<void>(() => {}); }),
      });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      cancel();
      expect(await result).toBe('start-app');
      const shownBefore = views.length;
      progress(80);
      expect(views.length).toBe(shownBefore);
      expect(deps.handoff).not.toHaveBeenCalled();
      expect(deps.recordFailure).not.toHaveBeenCalled();
      expect(deps.hide).toHaveBeenCalledTimes(1);
    });

    it('is ignored once the installer is being handed over', async () => {
      let cancel = () => {};
      let release: (value: boolean) => void = () => {};
      const { deps } = make({
        check: vi.fn(async () => ({ version: '2.0.0' })),
        onCancel: (callback: () => void) => { cancel = callback; },
        handoff: vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; })),
      });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      cancel();
      release(true);
      expect(await result).toBe('installing');
    });
  });

  it('still updates to a newer version than the one that failed', async () => {
    const { deps } = make({ check: vi.fn(async () => ({ version: '2.0.1' })), skipVersion: '2.0.0' });
    expect(await runStartupGate(deps)).toBe('installing');
  });

  describe('ask mode', () => {
    const asking = (over: Partial<GateDeps> = {}) => {
      let install!: () => void; let cancel!: () => void;
      const made = make({
        check: vi.fn(async () => ({ version: '2.0.0' })),
        onInstall: (cb) => { install = cb; }, onCancel: (cb) => { cancel = cb; }, ...over,
      });
      return { ...made, install: () => install(), cancel: () => cancel() };
    };

    it('offers the update, starts downloading at once and keeps the prompt on screen while it runs', async () => {
      let progress!: (p: number) => void;
      const { deps, views, cancel } = asking({ download: vi.fn((onProgress: (p: number) => void) => { progress = onProgress; return new Promise<void>(() => {}); }) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      expect(deps.download).toHaveBeenCalledTimes(1);
      progress(30);
      await vi.advanceTimersByTimeAsync(30_000);
      progress(60);
      expect(views).toEqual([{ kind: 'ask', version: '2.0.0' }]);
      // A window that crashed or failed to load answers "Later" through the same cancel path.
      cancel();
      expect(await result).toBe('start-app');
      expect(deps.hide).toHaveBeenCalledTimes(1);
    });

    it('re-checks once when "Install now" fails and does not record a failure for a vanished version', async () => {
      const check = vi.fn().mockResolvedValueOnce({ version: '2.0.0' }).mockResolvedValueOnce(undefined);
      const { deps, install } = asking({ check, download: vi.fn(async () => { throw new Error('404'); }) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      install();
      expect(await result).toBe('start-app');
      expect(check).toHaveBeenCalledTimes(2);
      expect(deps.recordFailure).not.toHaveBeenCalled();
    });

    it('still records the failure when the re-check finds the same version', async () => {
      const check = vi.fn(async () => ({ version: '2.0.0' }));
      const { deps, install } = asking({ check, download: vi.fn(async () => { throw new Error('disk full'); }) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      install();
      await vi.advanceTimersByTimeAsync(2500);
      expect(await result).toBe('start-app');
      expect(check).toHaveBeenCalledTimes(2);
      expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
    });

    it('"Install now" while the download is still running shows its progress, then hands over', async () => {
      let progress!: (p: number) => void; let finish!: () => void;
      const { deps, views, install } = asking({ download: vi.fn((onProgress: (p: number) => void) => new Promise<void>((resolve) => { progress = onProgress; finish = resolve; })) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      progress(20);
      install();
      await vi.advanceTimersByTimeAsync(10);
      progress(70);
      finish();
      expect(await result).toBe('installing');
      expect(views).toEqual([
        { kind: 'ask', version: '2.0.0' },
        { kind: 'downloading', version: '2.0.0', percent: 20 },
        { kind: 'downloading', version: '2.0.0', percent: 70 },
        { kind: 'installing', version: '2.0.0' },
      ]);
      expect(deps.download).toHaveBeenCalledTimes(1);
      expect(deps.handoff).toHaveBeenCalledWith('2.0.0', expect.any(Function));
      expect(deps.recordFailure).not.toHaveBeenCalled();
    });

    it('"Install now" after the download finished goes straight to the hand-over', async () => {
      const { deps, views, install } = asking();
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      install();
      expect(await result).toBe('installing');
      expect(views.map((v) => v.kind)).toEqual(['ask', 'installing']);
      expect(deps.download).toHaveBeenCalledTimes(1);
    });

    it('a download that failed while the prompt was open fails when "Install now" is chosen', async () => {
      const { deps, install } = asking({ download: vi.fn(async () => { throw new Error('disk full'); }) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      install();
      await vi.advanceTimersByTimeAsync(2500);
      expect(await result).toBe('start-app');
      expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
      expect(deps.handoff).not.toHaveBeenCalled();
    });

    it('"Later" after a failed download starts the app quietly, without a failure record or prompt loop', async () => {
      const { deps, cancel } = asking({ download: vi.fn(async () => { throw new Error('disk full'); }) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      cancel();
      expect(await result).toBe('start-app');
      expect(deps.recordFailure).not.toHaveBeenCalled();
      expect(deps.download).toHaveBeenCalledTimes(1);
    });

    it('a stalled download is still a failure when "Install now" is chosen after the stall', async () => {
      const { deps, install } = asking({ download: vi.fn(() => new Promise<void>(() => {})) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(61_000);
      install();
      await vi.advanceTimersByTimeAsync(2500);
      expect(await result).toBe('start-app');
      expect(deps.recordFailure).toHaveBeenCalledWith('2.0.0');
    });

    it('"Later" (or X, Escape) starts the app without installing or recording a failure and leaves the download running', async () => {
      const { deps, cancel } = asking({ download: vi.fn(() => new Promise<void>(() => {})) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      cancel();
      expect(await result).toBe('start-app');
      expect(deps.handoff).not.toHaveBeenCalled();
      expect(deps.markAttempt).toBeUndefined();
      expect(deps.recordFailure).not.toHaveBeenCalled();
      expect(deps.hide).toHaveBeenCalledTimes(1);
    });

    it('never prompts or downloads when there is no update, and never retries a failed version', async () => {
      const none = asking({ check: vi.fn(async () => undefined) });
      expect(await runStartupGate(none.deps)).toBe('start-app');
      expect(none.views).toEqual([]);
      const skipped = asking({ skipVersion: '2.0.0' });
      expect(await runStartupGate(skipped.deps)).toBe('start-app');
      expect(skipped.views).toEqual([]);
    });

    it('closing during the download after "Install now" still starts the app without a failure record', async () => {
      const { deps, install, cancel } = asking({ download: vi.fn(() => new Promise<void>(() => {})) });
      const result = runStartupGate(deps);
      await vi.advanceTimersByTimeAsync(10);
      install();
      await vi.advanceTimersByTimeAsync(10);
      cancel();
      expect(await result).toBe('start-app');
      expect(deps.recordFailure).not.toHaveBeenCalled();
    });
  });
});
