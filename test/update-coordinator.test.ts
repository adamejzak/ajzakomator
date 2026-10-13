import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInstallWindow, runStartupGate, type GateDeps, type GateView } from '../src/main/startupGate';
import { UpdateCoordinator, SupersededError, compareVersions, isSuperseded, type LookupResult, type UpdateBackend } from '../src/main/updateCoordinator';
import { createUpdateUiGuard } from '../src/main/updateUiGuard';

/** A fake feed + downloader: the test decides what the feed says and when each download ends. */
function harness(options: { portable?: boolean } = {}) {
  let feed: LookupResult = { latest: '0.6.4' };
  const downloads: Array<{ version: string; signal: AbortSignal; progress(percent: number): void; finish(): void; fail(error: Error): void }> = [];
  const backend: UpdateBackend = {
    lookup: vi.fn(async () => feed),
    download: vi.fn((version, onProgress, signal) => new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')));
      downloads.push({ version, signal, progress: (percent) => onProgress({ percent }), finish: resolve, fail: reject });
    })),
  };
  const emitted: Array<{ status: string; version?: string }> = [];
  const coordinator = new UpdateCoordinator({ backend, emit: (s) => { emitted.push({ status: s.status, version: s.version }); }, portable: () => !!options.portable, releasesUrl: 'https://releases.test' });
  const publish = (version: string | undefined) => { feed = version ? { latest: version, update: { version } } : { latest: '0.6.4' }; };
  return { coordinator, backend, downloads, emitted, publish, last: () => emitted[emitted.length - 1] };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('UpdateCoordinator state machine', () => {
  it('idle -> checking -> available -> downloading -> ready, one download for repeated looks', async () => {
    const h = harness();
    expect(h.coordinator.getState().status).toBe('idle');
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    expect(h.emitted.map((s) => s.status)).toEqual(['checking', 'available', 'downloading']);
    expect(h.coordinator.getState()).toMatchObject({ status: 'downloading', version: '0.6.5', percent: 0 });
    h.downloads[0].progress(42);
    expect(h.coordinator.getState()).toMatchObject({ percent: 42 });
    await h.coordinator.check('background'); await settle();
    expect(h.downloads).toHaveLength(1);
    h.downloads[0].finish(); await settle();
    expect(h.coordinator.getState()).toMatchObject({ status: 'ready', version: '0.6.5' });
    expect(h.coordinator.isDownloaded()).toBe(true);
    await h.coordinator.check('background'); await settle();
    expect(h.downloads).toHaveLength(1);
    expect(h.coordinator.getState().status).toBe('ready');
  });

  it('a background look while an update is offered is silent and a failure of it does not turn "ready" into an error', async () => {
    const h = harness();
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    h.downloads[0].finish(); await settle();
    const count = h.emitted.length;
    (h.backend.lookup as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    await h.coordinator.check('background');
    expect(h.coordinator.getState().status).toBe('ready');
    expect(h.emitted.length).toBe(count);
  });

  it('shows an error with the target version and retries by looking again', async () => {
    const h = harness();
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    h.downloads[0].fail(new Error('disk full')); await settle();
    expect(h.coordinator.getState()).toMatchObject({ status: 'error', version: '0.6.5', message: 'disk full' });
    await h.coordinator.check('manual'); await settle();
    expect(h.downloads).toHaveLength(2);
    h.downloads[1].finish(); await settle();
    expect(h.coordinator.getState().status).toBe('ready');
  });

  it('reports "current" when the feed has nothing newer and drops a target the feed no longer announces', async () => {
    const h = harness();
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    h.publish(undefined);
    await h.coordinator.check('background');
    expect(h.coordinator.getState()).toMatchObject({ status: 'current' });
    expect(h.coordinator.currentTarget()).toBeUndefined();
    expect(h.downloads[0].signal.aborted).toBe(true);
  });

  it('announces only a download link for builds that cannot install by themselves', async () => {
    const h = harness({ portable: true });
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    expect(h.coordinator.getState()).toMatchObject({ status: 'available', portable: true, url: 'https://releases.test' });
    expect(h.downloads).toHaveLength(0);
    expect(h.coordinator.installable()).toBe(false);
    expect(h.coordinator.lockHandover('0.6.5')).toBe(false);
  });

  it('stalled-download watchdog: no progress for two minutes is an error, later progress recovers', async () => {
    const h = harness();
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(h.coordinator.getState().status).toBe('error');
    h.downloads[0].progress(10);
    expect(h.coordinator.getState().status).toBe('downloading');
  });

  it('a look that never answers ends in an error instead of blocking every later check', async () => {
    const h = harness();
    (h.backend.lookup as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));
    const first = h.coordinator.check('manual');
    await vi.advanceTimersByTimeAsync(90 * 1000);
    await first;
    expect(h.coordinator.getState().status).toBe('error');
    h.publish('0.6.5');
    await h.coordinator.check('manual'); await settle();
    expect(h.coordinator.getState().status).toBe('downloading');
  });

  describe('supersede: the target is whatever is newest in the feed', () => {
    it('while available/downloading: cancels the old download, restarts for the newest, notifies listeners', async () => {
      const h = harness();
      const notify = vi.fn();
      h.coordinator.onTargetChange(notify);
      h.publish('0.6.5');
      await h.coordinator.check('background'); await settle();
      h.downloads[0].progress(60);
      h.publish('0.6.6');
      await h.coordinator.check('background'); await settle();
      expect(h.downloads[0].signal.aborted).toBe(true);
      expect(h.downloads).toHaveLength(2);
      expect(h.downloads[1].version).toBe('0.6.6');
      expect(notify).toHaveBeenCalledTimes(2);
      expect(h.coordinator.getState()).toMatchObject({ status: 'downloading', version: '0.6.6', percent: 0 });
      // Late progress of the cancelled download is ignored.
      h.downloads[0].progress(99);
      expect(h.coordinator.getState()).toMatchObject({ version: '0.6.6', percent: 0 });
      h.downloads[1].finish(); await settle();
      expect(h.coordinator.getState()).toMatchObject({ status: 'ready', version: '0.6.6' });
      expect(h.emitted.some((s) => s.status === 'ready' && s.version === '0.6.5')).toBe(false);
    });

    it('while ready: the old version is forgotten (it can no longer be installed)', async () => {
      const h = harness();
      h.publish('0.6.5');
      await h.coordinator.check('background'); await settle();
      h.downloads[0].finish(); await settle();
      h.publish('0.6.6');
      await h.coordinator.check('background'); await settle();
      expect(h.coordinator.isDownloaded('0.6.5')).toBe(false);
      expect(h.coordinator.lockHandover('0.6.5')).toBe(false);
      expect(h.coordinator.getState()).toMatchObject({ status: 'downloading', version: '0.6.6' });
    });

    it('a joined download of the superseded version rejects with SupersededError', async () => {
      const h = harness();
      h.publish('0.6.5');
      await h.coordinator.check('background'); await settle();
      const joined = h.coordinator.download();
      h.publish('0.6.6');
      await h.coordinator.check('background');
      const error = await joined.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SupersededError);
      expect(isSuperseded(error)).toBe(true);
    });

    it('during the hand-over: nothing changes, the newer version is only remembered', async () => {
      const h = harness();
      h.publish('0.6.5');
      await h.coordinator.check('background'); await settle();
      h.downloads[0].finish(); await settle();
      expect(h.coordinator.lockHandover('0.6.5')).toBe(true);
      expect(h.coordinator.lockHandover('0.6.5')).toBe(false);
      const count = h.emitted.length;
      h.publish('0.6.6');
      expect(await h.coordinator.check('background')).toBeUndefined();
      expect(h.coordinator.getState()).toMatchObject({ status: 'installing', version: '0.6.5' });
      expect(h.coordinator.newerVersion()).toBe('0.6.6');
      expect(h.coordinator.currentTarget()).toBe('0.6.5');
      expect(h.downloads).toHaveLength(1);
      expect(h.backend.lookup).toHaveBeenCalledTimes(2); // looked, but only to remember
      expect(h.emitted.length).toBe(count);
    });

    it('a failed hand-over releases the lock; then the newest version is offered normally', async () => {
      const h = harness();
      h.publish('0.6.5');
      await h.coordinator.check('background'); await settle();
      h.downloads[0].finish(); await settle();
      h.coordinator.lockHandover('0.6.5');
      h.coordinator.failHandover(new Error('installer failed'));
      expect(h.coordinator.handoverVersion()).toBeUndefined();
      expect(h.coordinator.getState()).toMatchObject({ status: 'error', version: '0.6.5' });
      h.publish('0.6.6');
      await h.coordinator.check('manual'); await settle();
      expect(h.coordinator.getState()).toMatchObject({ status: 'downloading', version: '0.6.6' });
    });

    it('a blocked version is not offered; a newer one is', async () => {
      const h = harness();
      h.coordinator.block('0.6.5');
      h.publish('0.6.5');
      await h.coordinator.check('background'); await settle();
      expect(h.coordinator.getState().status).toBe('current');
      expect(h.downloads).toHaveLength(0);
      h.publish('0.6.6');
      await h.coordinator.check('background'); await settle();
      expect(h.downloads[0].version).toBe('0.6.6');
    });
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.6.10', '0.6.9')).toBeGreaterThan(0);
    expect(compareVersions('0.6.6', '0.6.5')).toBeGreaterThan(0);
  });
});

describe('the update window follows the newest target', () => {
  /** The window deps wired to a real coordinator, the way index.ts does it. */
  function wired(h: ReturnType<typeof harness>, over: Partial<GateDeps> = {}) {
    const views: GateView[] = [];
    const handed: string[] = [];
    let install = () => {}; let cancel = () => {};
    const deps: GateDeps = {
      check: () => h.coordinator.check('startup'),
      recheck: () => h.coordinator.check('recheck'),
      download: async (onProgress) => { const off = h.coordinator.addProgressListener(onProgress); try { await h.coordinator.download(); } finally { off(); } },
      target: () => h.coordinator.currentTarget(), isDownloaded: (version) => h.coordinator.isDownloaded(version),
      onTargetChange: (listener) => h.coordinator.onTargetChange(listener),
      show: (view) => { views.push(view); }, hide: vi.fn(),
      onInstall: (cb) => { install = cb; }, onCancel: (cb) => { cancel = cb; },
      handoff: async (version, hide) => { if (!h.coordinator.lockHandover(version)) return false; hide(); handed.push(version); return true; },
      recordFailure: vi.fn(),
      ...over,
    };
    return { deps, views, handed, install: () => install(), cancel: () => cancel() };
  }
  const last = (views: GateView[]) => views[views.length - 1];

  it('ask prompt open: a newer release replaces the version in the prompt, "Install now" installs the newest only', async () => {
    const h = harness();
    h.publish('0.6.5');
    const w = wired(h);
    const result = runStartupGate(w.deps);
    await settle();
    expect(last(w.views)).toEqual({ kind: 'ask', version: '0.6.5' });
    h.publish('0.6.6');
    await h.coordinator.check('background'); await settle();
    expect(last(w.views)).toEqual({ kind: 'ask', version: '0.6.6' });
    expect(h.downloads.map((d) => d.version)).toEqual(['0.6.5', '0.6.6']);
    w.install(); await settle();
    expect(last(w.views)).toEqual({ kind: 'downloading', version: '0.6.6', percent: 0 });
    h.downloads[1].finish(); await settle();
    expect(await result).toBe('installing');
    expect(w.handed).toEqual(['0.6.6']);
    expect(w.views.filter((v) => v.kind === 'installing')).toEqual([{ kind: 'installing', version: '0.6.6' }]);
  });

  it('chosen and downloading: a newer release restarts the download in the same window, the old version is never installing', async () => {
    const h = harness();
    h.publish('0.6.5');
    const w = wired(h);
    const result = runStartupGate(w.deps);
    await settle(); w.install(); await settle();
    h.downloads[0].progress(70); await settle();
    expect(last(w.views)).toEqual({ kind: 'downloading', version: '0.6.5', percent: 70 });
    h.publish('0.6.6');
    await h.coordinator.check('background'); await settle();
    expect(last(w.views)).toEqual({ kind: 'downloading', version: '0.6.6', percent: 0 });
    h.downloads[1].progress(30); await settle();
    expect(last(w.views)).toEqual({ kind: 'downloading', version: '0.6.6', percent: 30 });
    h.downloads[1].finish(); await settle();
    expect(await result).toBe('installing');
    expect(w.handed).toEqual(['0.6.6']);
    expect(w.views.some((v) => v.kind === 'installing' && v.version === '0.6.5')).toBe(false);
    expect(w.deps.recordFailure).not.toHaveBeenCalled();
  });

  it('the last look before the hand-over finds a newer release after the old one was fully downloaded', async () => {
    const h = harness();
    h.publish('0.6.5');
    const w = wired(h);
    const result = runStartupGate(w.deps);
    await settle();
    h.downloads[0].finish(); await settle();
    // The feed changes silently (no periodic check ran); the click triggers the last look.
    h.publish('0.6.6');
    w.install(); await settle();
    expect(last(w.views)).toEqual({ kind: 'downloading', version: '0.6.6', percent: 0 });
    expect(w.handed).toEqual([]);
    h.downloads[1].finish(); await settle();
    expect(await result).toBe('installing');
    expect(w.handed).toEqual(['0.6.6']);
  });

  it('status bar click on a ready update: window opens, the last look supersedes, the newest installs', async () => {
    const h = harness();
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    h.downloads[0].finish(); await settle();
    h.publish('0.6.6');
    const w = wired(h);
    const result = runInstallWindow(w.deps, '0.6.5');
    await settle();
    expect(last(w.views)).toEqual({ kind: 'downloading', version: '0.6.6', percent: 0 });
    h.downloads[1].finish(); await settle();
    expect(await result).toBe('installing');
    expect(w.handed).toEqual(['0.6.6']);
  });

  it('status bar click while a background download runs joins it (no second download) and installs when it ends', async () => {
    const h = harness();
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    h.downloads[0].progress(50);
    const w = wired(h);
    const result = runInstallWindow(w.deps, '0.6.5');
    await settle();
    expect(h.downloads).toHaveLength(1);
    expect(last(w.views).kind).toBe('downloading');
    h.downloads[0].finish(); await settle();
    expect(await result).toBe('installing');
    expect(w.handed).toEqual(['0.6.5']);
  });

  it('status bar click on a ready update installs at once through the window', async () => {
    const h = harness();
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    h.downloads[0].finish(); await settle();
    const w = wired(h);
    const result = runInstallWindow(w.deps, '0.6.5');
    await settle();
    expect(await result).toBe('installing');
    expect(w.handed).toEqual(['0.6.5']);
    expect(w.views.map((v) => v.kind)).toEqual(['installing']);
  });

  it('user pressed install for A and B appears during the hand-over: A finishes, B is offered after the relaunch', async () => {
    const h = harness();
    h.publish('0.6.5');
    let release!: (value: boolean) => void;
    const w = wired(h, {
      handoff: (version, hide) => { if (!h.coordinator.lockHandover(version)) return Promise.resolve(false); hide(); return new Promise<boolean>((resolve) => { release = resolve; }); },
    });
    const result = runStartupGate(w.deps);
    await settle(); w.install(); await settle();
    h.downloads[0].finish(); await settle();
    expect(h.coordinator.handoverVersion()).toBe('0.6.5');
    h.publish('0.6.6');
    await h.coordinator.check('background'); await settle();
    expect(h.coordinator.getState()).toMatchObject({ status: 'installing', version: '0.6.5' });
    expect(h.downloads).toHaveLength(1);
    expect(last(w.views)).toEqual({ kind: 'installing', version: '0.6.5' });
    release(true);
    expect(await result).toBe('installing');
    expect(h.coordinator.newerVersion()).toBe('0.6.6');
    // After the relaunch (a new process: a fresh coordinator) the normal flow offers B.
    const next = harness();
    next.publish('0.6.6');
    const again = wired(next);
    const second = runStartupGate(again.deps);
    await settle();
    expect(last(again.views)).toEqual({ kind: 'ask', version: '0.6.6' });
    again.cancel(); expect(await second).toBe('start-app');
  });

  it('closing the window mid-download leaves the download running for the status bar', async () => {
    const h = harness();
    h.publish('0.6.5');
    await h.coordinator.check('background'); await settle();
    const w = wired(h);
    const result = runInstallWindow(w.deps, '0.6.5');
    await settle();
    w.cancel();
    expect(await result).toBe('start-app');
    expect(h.coordinator.getState().status).toBe('downloading');
    h.downloads[0].finish(); await settle();
    expect(h.coordinator.getState().status).toBe('ready');
    expect(w.handed).toEqual([]);
  });
});

describe('single update UI', () => {
  it('lets only one of the startup prompt and the status bar window exist at a time', () => {
    const guard = createUpdateUiGuard();
    expect(guard.acquire('startup-gate')).toBe(true);
    expect(guard.acquire('install-window')).toBe(false);
    expect(guard.acquire('startup-gate')).toBe(false);
    guard.release('install-window');
    expect(guard.owner()).toBe('startup-gate');
    guard.release('startup-gate');
    expect(guard.acquire('install-window')).toBe(true);
    expect(guard.acquire('startup-gate')).toBe(false);
    expect(guard.acquire('install-window')).toBe(false);
    guard.release('install-window');
    expect(guard.owner()).toBeUndefined();
  });
});
