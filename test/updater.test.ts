import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ app: { isPackaged: true, once: vi.fn(), quit: vi.fn() }, check: vi.fn(), download: vi.fn(), install: vi.fn() }));
vi.mock('electron', () => ({ app: mock.app }));
const splash = vi.hoisted(() => ({ show: vi.fn(), stage: vi.fn(), abort: vi.fn() }));
vi.mock('../src/main/updateSplash', () => ({ showUpdateWindow: splash.show, stageSplashRuntime: splash.stage, abortUpdateWindow: splash.abort }));
const strings = { title: 't' } as never;
type Updater = EventEmitter & { requestHeaders?: Record<string, string>; autoDownload: boolean; autoInstallOnAppQuit: boolean; quitAndInstallCalled?: boolean; checkForUpdates: typeof mock.check; downloadUpdate: typeof mock.download; install: typeof mock.install };
let updater: Updater;
vi.mock('electron-updater', () => ({
  get autoUpdater() { return updater; },
  CancellationToken: class { cancelled = false; listeners: Array<() => void> = []; cancel() { this.cancelled = true; this.listeners.forEach((l) => l()); } },
}));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

/** A feed answer: a newer version, or nothing. */
const found = (version: string) => ({ isUpdateAvailable: true, updateInfo: { version } });
const none = (version = '0.5.8') => ({ isUpdateAvailable: false, updateInfo: { version } });

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks();
  // The default cases exercise the installed Windows updater on every CI host.
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  vi.stubEnv('PORTABLE_EXECUTABLE_FILE', '');
  vi.stubEnv('PORTABLE_EXECUTABLE_DIR', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mock.app.isPackaged = true;
  mock.check.mockResolvedValue(none()); mock.install.mockReturnValue(true);
  mock.download.mockResolvedValue([]);
  splash.show.mockResolvedValue(true); splash.stage.mockResolvedValue('runtime.exe'); splash.abort.mockResolvedValue(undefined);
  updater = Object.assign(new EventEmitter(), { autoDownload: true, autoInstallOnAppQuit: true, checkForUpdates: mock.check, downloadUpdate: mock.download, install: mock.install });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platformDescriptor); });
const setup = async (withStrings = false) => {
  const api = await import('../src/main/updater');
  const changed = vi.fn();
  api.initUpdater(changed, withStrings ? { strings: () => strings } : {});
  return { ...api, changed };
};
/** Lets the background download a check started run (mocked downloads answer at once). */
const settle = () => vi.advanceTimersByTimeAsync(0);
const statuses = (changed: ReturnType<typeof vi.fn>) => changed.mock.calls.map(([s]) => (s as { status: string }).status);
/** A download the test finishes (or cancels through the token) by hand. */
function controlledDownload() {
  const runs: Array<{ token: { cancelled: boolean }; finish(): void; fail(error: Error): void }> = [];
  mock.download.mockImplementation((token: { cancelled: boolean; listeners: Array<() => void> }) => new Promise((resolve, reject) => {
    const run = { token, finish: () => resolve([]), fail: (error: Error) => reject(error) };
    token.listeners.push(() => reject(new Error('cancelled')));
    runs.push(run);
  }));
  return runs;
}

describe('updater lifecycle (Windows)', () => {
  it('publishes checking synchronously and errors on a failed look, then allows retry', async () => {
    const api = await setup();
    mock.check.mockRejectedValueOnce(new Error('network offline'));
    const check = api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('checking');
    await check;
    expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'network offline' });
    await api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('current');
  });

  it('never downloads or installs by itself', async () => {
    await setup();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    updater.emit('update-downloaded', { version: '0.5.0' });
    expect(mock.install).not.toHaveBeenCalled();
  });

  it('deduplicates checks', async () => {
    const api = await setup();
    let finish!: (value: object) => void;
    mock.check.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = api.checkForUpdates(); const second = api.checkForUpdates();
    expect(mock.check).toHaveBeenCalledTimes(1);
    finish(none()); await Promise.all([first, second]);
  });

  it('available -> downloading (clamped progress) -> ready, one download', async () => {
    const api = await setup();
    const runs = controlledDownload();
    mock.check.mockResolvedValue(found('0.5.9'));
    await api.checkForUpdates(); await settle();
    expect(api.getUpdateState()).toMatchObject({ status: 'downloading', version: '0.5.9', percent: 0 });
    updater.emit('download-progress', { percent: 125, transferred: 100, total: 100, bytesPerSecond: 50 });
    expect(api.getUpdateState()).toMatchObject({ status: 'downloading', percent: 100, transferred: 100, total: 100, bytesPerSecond: 50 });
    runs[0].finish(); await settle();
    expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.5.9' });
    expect(statuses(api.changed)).toEqual(['checking', 'available', 'downloading', 'downloading', 'ready']);
    await api.checkForUpdates(); await settle();
    expect(mock.download).toHaveBeenCalledTimes(1);
    expect(api.getUpdateState().status).toBe('ready');
  });

  it('what the status bar button may do in each state', async () => {
    const api = await setup();
    expect(api.canInstallNow()).toBe(false);
    const runs = controlledDownload();
    mock.check.mockResolvedValue(found('0.5.9'));
    await api.checkForUpdates();
    expect(api.canInstallNow()).toBe(true); // available / downloading
    await settle();
    expect(api.getUpdateState().status).toBe('downloading');
    expect(api.canInstallNow()).toBe(true);
    runs[0].finish(); await settle();
    expect(api.getUpdateState().status).toBe('ready');
    expect(api.canInstallNow()).toBe(true);
    expect(await api.handOver('0.5.9', vi.fn())).toBe(true);
    expect(api.getUpdateState().status).toBe('installing');
    expect(api.canInstallNow()).toBe(false);
  });

  it('shows a failed download as an error and the next check tries again', async () => {
    const api = await setup();
    mock.download.mockRejectedValueOnce(new Error('download interrupted'));
    mock.check.mockResolvedValue(found('0.5.9'));
    await api.checkForUpdates(); await settle();
    expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'download interrupted', version: '0.5.9' });
    await api.checkForUpdates(); await settle();
    expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.5.9' });
    expect(mock.download).toHaveBeenCalledTimes(2);
  });

  it('reports a disabled provider as an error', async () => {
    const api = await setup();
    mock.check.mockResolvedValueOnce(null);
    await api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('error');
  });

  it('never downloads or installs portable updates and provides the release link', async () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', 'D:/app.exe');
    const api = await setup();
    mock.check.mockResolvedValue(found('0.5.9'));
    await api.checkForUpdates(); await settle();
    expect(api.getUpdateState()).toMatchObject({ status: 'available', portable: true, url: api.RELEASES_URL, version: '0.5.9' });
    expect(mock.download).not.toHaveBeenCalled();
    expect(api.canInstallNow()).toBe(false);
    expect(await api.handOver('0.5.9', vi.fn())).toBe(false);
    expect(mock.install).not.toHaveBeenCalled();
  });

  it('exposes disabled development checks', async () => {
    mock.app.isPackaged = false;
    const api = await setup(); await api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('unavailable'); expect(mock.check).not.toHaveBeenCalled();
  });

  it('exposes a stalled transfer and recovers when progress resumes', async () => {
    const api = await setup();
    controlledDownload();
    mock.check.mockResolvedValue(found('0.5.9'));
    await api.checkForUpdates(); await settle();
    await vi.advanceTimersByTimeAsync(120000);
    expect(api.getUpdateState().status).toBe('error');
    updater.emit('download-progress', { percent: 50, transferred: 50, total: 100, bytesPerSecond: 10 });
    expect(api.getUpdateState().status).toBe('downloading');
  });

  it('does not register duplicate listeners; an installer failing after it started is shown and can be retried', async () => {
    const api = await setup(); api.initUpdater(vi.fn());
    expect(updater.listenerCount('error')).toBe(1);
    mock.check.mockResolvedValue(found('0.5.9'));
    await api.checkForUpdates(); await settle();
    updater.emit('error', new Error('stray')); // not during a hand-over: only logged
    expect(api.getUpdateState().status).toBe('ready');
    expect(await api.handOver('0.5.9', vi.fn())).toBe(true);
    updater.emit('error', new Error('installer failed'));
    expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'installer failed' });
    expect(api.updateHandoffStarted()).toBe(false);
  });

  it('checks in the background at startup and periodically, then cleans up on quit', async () => {
    await setup();
    await vi.advanceTimersByTimeAsync(8000);
    expect(mock.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mock.check).toHaveBeenCalledTimes(2);
    mock.app.once.mock.calls.find(([event]) => event === 'before-quit')![1]();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mock.check).toHaveBeenCalledTimes(2);
  });

  it('a periodic check finds a release that appeared while an older one was downloaded (no stale "ready" forever)', async () => {
    const api = await setup();
    mock.check.mockResolvedValue(found('0.5.9'));
    await vi.advanceTimersByTimeAsync(8000); await settle();
    expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.5.9' });
    mock.check.mockResolvedValue(found('0.6.0'));
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000); await settle();
    expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.6.0' });
    expect(mock.download).toHaveBeenCalledTimes(2);
  });

  it('returns a defensive state snapshot', async () => {
    const api = await setup();
    const snapshot = api.getUpdateState(); snapshot.status = 'ready';
    expect(api.getUpdateState().status).toBe('idle');
  });

  it('asks for fresh release data and remembers when the last check found nothing', async () => {
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    const api = await setup();
    expect(updater.requestHeaders).toMatchObject({ 'Cache-Control': 'no-cache' });
    mock.check.mockResolvedValue(none('0.5.5'));
    await api.checkForUpdates();
    expect(api.getUpdateState()).toMatchObject({ status: 'current', version: '0.5.5', checkedAt: Date.parse('2026-10-11T10:00:00Z') });
  });

  describe('newer release while an older one is offered (supersede)', () => {
    it('while downloading: cancels the old download, downloads the newest, never shows ready for the old one', async () => {
      const api = await setup();
      const runs = controlledDownload();
      mock.check.mockResolvedValue(found('0.6.5'));
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState()).toMatchObject({ status: 'downloading', version: '0.6.5' });
      mock.check.mockResolvedValue(found('0.6.6'));
      await api.checkForUpdates(); await settle();
      expect(runs[0].token.cancelled).toBe(true);
      expect(runs).toHaveLength(2);
      expect(api.getUpdateState()).toMatchObject({ status: 'downloading', version: '0.6.6', percent: 0 });
      runs[1].finish(); await settle();
      expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.6.6' });
      expect(api.changed.mock.calls.some(([s]) => (s as { status: string; version?: string }).status === 'ready' && (s as { version?: string }).version === '0.6.5')).toBe(false);
      expect(await api.handOver('0.6.5', vi.fn())).toBe(false);
      expect(await api.handOver('0.6.6', vi.fn())).toBe(true);
    });

    it('while ready: forgets the old version and downloads the newest', async () => {
      const api = await setup();
      mock.check.mockResolvedValue(found('0.6.5'));
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.6.5' });
      mock.check.mockResolvedValue(found('0.6.6'));
      const notify = vi.fn();
      api.onUpdateTargetChange(notify);
      await api.checkForUpdates(); await settle();
      expect(notify).toHaveBeenCalledOnce();
      expect(api.updateTarget()).toBe('0.6.6');
      expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.6.6' });
      expect(mock.download).toHaveBeenCalledTimes(2);
    });

    it('during the hand-over: the old version finishes, the newer one is only remembered and offered after the relaunch', async () => {
      const api = await setup();
      mock.check.mockResolvedValue(found('0.6.5'));
      await api.checkForUpdates(); await settle();
      expect(await api.handOver('0.6.5', vi.fn())).toBe(true);
      const states = api.changed.mock.calls.length;
      mock.check.mockResolvedValue(found('0.6.6'));
      await api.checkForUpdates('background'); await settle();
      expect(api.getUpdateState()).toMatchObject({ status: 'installing', version: '0.6.5' });
      expect(api.changed.mock.calls.length).toBe(states); // nothing was published
      expect(mock.download).toHaveBeenCalledTimes(1);
      expect(mock.check).toHaveBeenCalledTimes(2); // looked, but only to remember it
      expect(api.newerVersionAfterHandover()).toBe('0.6.6');
      expect(api.updateHandoffStarted()).toBe(true);
    });

    it('the last look before the hand-over supersedes the target and keeps the old version out of the installer', async () => {
      const api = await setup();
      mock.check.mockResolvedValue(found('0.6.5'));
      await api.startupCheck(); await settle();
      mock.check.mockResolvedValue(found('0.6.6'));
      expect(await api.recheckUpdate()).toEqual({ version: '0.6.6' });
      expect(api.updateTarget()).toBe('0.6.6');
      expect(await api.handOver('0.6.5', vi.fn())).toBe(false);
      await settle();
      expect(await api.handOver('0.6.6', vi.fn())).toBe(true);
    });

    it('a failing last look changes nothing', async () => {
      const api = await setup();
      mock.check.mockResolvedValue(found('0.6.5'));
      await api.startupCheck(); await settle();
      mock.check.mockRejectedValue(new Error('offline'));
      await expect(api.recheckUpdate()).rejects.toThrow('offline');
      expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.6.5' });
    });
  });

  describe('startup gate helpers', () => {
    it('looks and starts the download for the prompt, a second caller joins it', async () => {
      const api = await setup(true);
      const runs = controlledDownload();
      mock.check.mockResolvedValueOnce(found('0.6.0'));
      expect(await api.startupCheck()).toEqual({ version: '0.6.0' });
      await settle();
      const progress = vi.fn();
      const running = api.startupDownload(progress);
      const second = api.startupDownload(vi.fn());
      updater.emit('download-progress', { percent: 40, transferred: 4, total: 10, bytesPerSecond: 1 });
      expect(progress).toHaveBeenCalledWith(40);
      expect(api.getUpdateState()).toMatchObject({ status: 'downloading', percent: 40 });
      runs[0].finish(); await Promise.all([running, second]);
      expect(mock.download).toHaveBeenCalledTimes(1);
      expect(api.getUpdateState().status).toBe('ready');
    });
    it('answers nothing when current, rethrows a failed look and reports nothing installable for portable builds', async () => {
      const api = await setup(true);
      expect(await api.startupCheck()).toBeUndefined();
      mock.check.mockRejectedValueOnce(new Error('offline'));
      await expect(api.startupCheck()).rejects.toThrow('offline');
      expect(updater.autoDownload).toBe(false);
    });
    it('reports a failed startup download as an update error', async () => {
      const api = await setup(true);
      mock.download.mockRejectedValueOnce(new Error('disk full'));
      mock.check.mockResolvedValueOnce(found('0.6.0'));
      await api.startupCheck();
      await expect(api.startupDownload(vi.fn())).rejects.toThrow('disk full');
      expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'disk full' });
    });
    it('hands over to the installer only for the downloaded target, hiding the update window first', async () => {
      const api = await setup(true);
      const hide = vi.fn();
      expect(await api.handOver('0.6.0', hide)).toBe(false);
      mock.check.mockResolvedValueOnce(found('0.6.0'));
      await api.startupCheck(); await api.startupDownload(vi.fn());
      mock.install.mockImplementationOnce(() => { expect(hide).toHaveBeenCalledOnce(); return true; });
      expect(await api.handOver('0.6.0', hide)).toBe(true);
      expect(splash.show).toHaveBeenCalledExactlyOnceWith('0.6.0', strings);
      expect(mock.install).toHaveBeenCalledExactlyOnceWith(true, true);
      expect(mock.app.quit).toHaveBeenCalledOnce();
      expect(api.getUpdateState().status).toBe('installing');
      await api.handOver('0.6.0', vi.fn());
      expect(mock.install).toHaveBeenCalledTimes(1);
    });
    it('does not report a hand-over when the installer did not start, closes the window and allows a retry', async () => {
      const api = await setup(true);
      mock.check.mockResolvedValue(found('0.6.0'));
      await api.startupCheck(); await api.startupDownload(vi.fn());
      updater.quitAndInstallCalled = true;
      mock.install.mockReturnValueOnce(false);
      expect(await api.handOver('0.6.0', vi.fn())).toBe(false);
      expect(mock.app.quit).not.toHaveBeenCalled();
      expect(splash.abort).toHaveBeenCalledOnce();
      expect(api.getUpdateState().status).toBe('error');
      expect(updater.quitAndInstallCalled).toBe(false);
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.6.0' });
      expect(await api.handOver('0.6.0', vi.fn())).toBe(true);
    });
    it('reports a hand-over that throws', async () => {
      const api = await setup(true);
      mock.check.mockResolvedValue(found('0.6.0'));
      await api.startupCheck(); await api.startupDownload(vi.fn());
      mock.install.mockImplementationOnce(() => { throw new Error('installer failed'); });
      expect(await api.handOver('0.6.0', vi.fn())).toBe(false);
      expect(splash.abort).toHaveBeenCalledOnce();
      expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'installer failed' });
    });
    it('never offers or installs a blocked version, and offers newer ones', async () => {
      const api = await setup(true);
      api.blockUpdateVersion('0.6.0');
      mock.check.mockResolvedValue(found('0.6.0'));
      await api.checkForUpdates(); await settle();
      expect(mock.download).not.toHaveBeenCalled();
      expect(api.getUpdateState().status).toBe('current');
      expect(await api.handOver('0.6.0', vi.fn())).toBe(false);
      mock.check.mockResolvedValue(found('0.7.0'));
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.7.0' });
    });
    it('withdraws an already downloaded version once it is blocked, and downloads again after the block is lifted', async () => {
      const api = await setup(true);
      mock.check.mockResolvedValue(found('0.6.0'));
      await api.checkForUpdates(); await settle();
      api.blockUpdateVersion('0.6.0');
      expect(api.getUpdateState().status).toBe('current');
      expect(await api.handOver('0.6.0', vi.fn())).toBe(false);
      api.blockUpdateVersion(undefined);
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState().status).toBe('ready');
    });
  });

  describe('update window', () => {
    it('stages the window runtime in the background while downloading', async () => {
      const api = await setup(true);
      mock.check.mockResolvedValue(found('0.6.0'));
      await api.checkForUpdates(); await settle();
      expect(splash.stage).toHaveBeenCalled();
    });
    it('does not stage anything without localized strings or for portable builds', async () => {
      const api = await setup(); mock.check.mockResolvedValue(found('0.6.0'));
      await api.checkForUpdates(); await settle();
      expect(splash.stage).not.toHaveBeenCalled();
      vi.resetModules(); vi.stubEnv('PORTABLE_EXECUTABLE_FILE', 'D:/app.exe');
      const portable = await setup(true); await portable.checkForUpdates(); await settle();
      expect(splash.stage).not.toHaveBeenCalled();
    });
    it('installs without the window when it cannot be shown, and survives a crashing window', async () => {
      splash.show.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('spawn failed'));
      const api = await setup(true);
      mock.check.mockResolvedValue(found('0.6.0'));
      await api.checkForUpdates(); await settle();
      expect(await api.handOver('0.6.0', vi.fn())).toBe(true);
      expect(mock.install).toHaveBeenCalledTimes(1);
      expect(splash.abort).not.toHaveBeenCalled();
    });
  });
});
