import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ app: { isPackaged: true, once: vi.fn(), quit: vi.fn() }, check: vi.fn(), quit: vi.fn(), install: vi.fn() }));
vi.mock('electron', () => ({ app: mock.app }));
const splash = vi.hoisted(() => ({ show: vi.fn(), stage: vi.fn(), abort: vi.fn() }));
vi.mock('../src/main/updateSplash', () => ({ showUpdateWindow: splash.show, stageSplashRuntime: splash.stage, abortUpdateWindow: splash.abort }));
const strings = { title: 't' } as never;
let updater: EventEmitter & { requestHeaders?: Record<string, string>; autoDownload: boolean; autoInstallOnAppQuit: boolean; checkForUpdates: typeof mock.check; quitAndInstall: typeof mock.quit; install: typeof mock.install };
vi.mock('electron-updater', () => ({ get autoUpdater() { return updater; } }));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks();
  // The default cases exercise the installed Windows updater on every CI host.
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  vi.stubEnv('PORTABLE_EXECUTABLE_FILE', '');
  vi.stubEnv('PORTABLE_EXECUTABLE_DIR', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mock.app.isPackaged = true;
  mock.check.mockResolvedValue({}); mock.install.mockReturnValue(true);
  splash.show.mockResolvedValue(true); splash.stage.mockResolvedValue('runtime.exe'); splash.abort.mockResolvedValue(undefined);
  updater = Object.assign(new EventEmitter(), { autoDownload: false, autoInstallOnAppQuit: true, checkForUpdates: mock.check, quitAndInstall: mock.quit, install: mock.install });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platformDescriptor); });
const setup = async () => { const api = await import('../src/main/updater'); const changed = vi.fn(); api.initUpdater(changed); return { ...api, changed }; };

describe('updater lifecycle', () => {
  it('publishes checking synchronously and errors even without an error event, then allows retry', async () => {
    const api = await setup();
    mock.check.mockRejectedValueOnce(new Error('network offline'));
    const check = api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('checking');
    await check;
    expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'network offline' });
    mock.check.mockImplementationOnce(async () => { updater.emit('update-not-available'); return {}; });
    await api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('current');
  });
  it('deduplicates checks and does not replace a downloaded update with a background check', async () => {
    const api = await setup();
    let finish!: (value: object) => void;
    mock.check.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = api.checkForUpdates(); const second = api.checkForUpdates();
    expect(mock.check).toHaveBeenCalledTimes(1);
    finish({}); await Promise.all([first, second]);
    updater.emit('update-downloaded', { version: '0.5.0' });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mock.check).toHaveBeenCalledTimes(1);
    expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.5.0' });
  });
  it('reports transfer progress, clamps percentages and hands off installation only once', async () => {
    const api = await setup();
    updater.emit('update-available', { version: '0.5.0' });
    updater.emit('download-progress', { percent: 125, transferred: 100, total: 100, bytesPerSecond: 50 });
    expect(api.getUpdateState()).toMatchObject({ status: 'downloading', percent: 100, transferred: 100, total: 100, bytesPerSecond: 50 });
    updater.emit('update-downloaded', { version: '0.5.0' });
    api.installNow(); api.installNow();
    expect(api.getUpdateState().status).toBe('installing');
    expect(mock.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(mock.quit).toHaveBeenCalledExactlyOnceWith(true, true);
  });
  it('never downloads or installs portable updates and provides the release link', async () => {
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', 'D:/app.exe');
    const api = await setup();
    expect(updater.autoDownload).toBe(false);
    updater.emit('update-available', { version: '0.5.0' });
    expect(api.getUpdateState()).toMatchObject({ status: 'available', portable: true, url: api.RELEASES_URL });
    updater.emit('update-downloaded', { version: '0.5.0' });
    api.installNow();
    expect(mock.quit).not.toHaveBeenCalled(); expect(mock.install).not.toHaveBeenCalled();
  });
  it('exposes disabled development checks', async () => {
    mock.app.isPackaged = false;
    const api = await setup(); await api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('unavailable'); expect(mock.check).not.toHaveBeenCalled();
  });
  it('exposes a stalled transfer and recovers when progress resumes', async () => {
    const api = await setup();
    updater.emit('update-available', { version: '0.5.0' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(api.getUpdateState().status).toBe('error');
    updater.emit('download-progress', { percent: 50, transferred: 50, total: 100, bytesPerSecond: 10 });
    expect(api.getUpdateState().status).toBe('downloading');
  });
  it('does not register duplicate timers/listeners and makes installation failures visible', async () => {
    const api = await setup(); api.initUpdater(vi.fn());
    expect(updater.listenerCount('error')).toBe(1);
    updater.emit('update-downloaded', { version: '0.5.0' });
    mock.quit.mockImplementationOnce(() => { throw new Error('installer failed'); });
    api.installNow(); await vi.advanceTimersByTimeAsync(400);
    expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'installer failed' });
  });
  it('checks in the background at startup and periodically, then cleans up on quit', async () => {
    const api = await setup();
    mock.check.mockImplementation(async () => { updater.emit('update-not-available'); return {}; });
    await vi.advanceTimersByTimeAsync(8000);
    expect(mock.check).toHaveBeenCalledTimes(1);
    expect(api.getUpdateState().status).toBe('current');
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mock.check).toHaveBeenCalledTimes(2);
    mock.app.once.mock.calls.find(([event]) => event === 'before-quit')![1]();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mock.check).toHaveBeenCalledTimes(2);
  });
  it('reports a disabled provider and a download rejection without error events', async () => {
    const api = await setup();
    mock.check.mockResolvedValueOnce(null);
    await api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('error');
    mock.check.mockImplementationOnce(async () => {
      updater.emit('update-available', { version: '0.5.0' });
      return { downloadPromise: Promise.reject(new Error('download interrupted')) };
    });
    await api.checkForUpdates();
    expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'download interrupted', version: '0.5.0' });
  });
  it('returns a defensive state snapshot', async () => {
    const api = await setup();
    updater.emit('update-downloaded', { version: '0.5.0' });
    const snapshot = api.getUpdateState(); snapshot.status = 'idle';
    expect(api.getUpdateState().status).toBe('ready');
  });

  it('asks for fresh release data and remembers when the last check found nothing', async () => {
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
    const api = await setup();
    expect(updater.requestHeaders).toMatchObject({ 'Cache-Control': 'no-cache' });
    updater.emit('update-not-available', { version: '0.5.5' });
    expect(api.getUpdateState()).toMatchObject({ status: 'current', version: '0.5.5', checkedAt: Date.parse('2026-10-11T10:00:00Z') });
  });
  describe('startup gate helpers', () => {
    const setupGate = async () => { const api = await import('../src/main/updater'); api.initUpdater(vi.fn(), { strings: () => strings }); return api; };
    it('checks without downloading and restores automatic download afterwards', async () => {
      const api = await setupGate();
      mock.check.mockImplementationOnce(async () => { expect(updater.autoDownload).toBe(false); return { isUpdateAvailable: true, updateInfo: { version: '0.6.0' } }; });
      expect(await api.startupCheck()).toEqual({ version: '0.6.0' });
      expect(updater.autoDownload).toBe(true);
      mock.check.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: '0.5.8' } });
      expect(await api.startupCheck()).toBeUndefined();
      mock.check.mockRejectedValueOnce(new Error('offline'));
      await expect(api.startupCheck()).rejects.toThrow('offline');
      expect(updater.autoDownload).toBe(true);
    });
    it('downloads late answers of an abandoned check in the background', async () => {
      const api = await setupGate();
      const download = vi.fn().mockResolvedValue([]);
      Object.assign(updater, { downloadUpdate: download });
      api.abandonStartupCheck();
      mock.check.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: { version: '0.6.0' } });
      await api.startupCheck();
      expect(download).toHaveBeenCalledOnce();
    });
    it('never installs on quit by itself, whatever the update state', async () => {
      await setupGate();
      expect(updater.autoInstallOnAppQuit).toBe(false);
      updater.emit('update-downloaded', { version: '0.6.0' });
      expect(updater.autoInstallOnAppQuit).toBe(false);
      expect(mock.install).not.toHaveBeenCalled(); expect(mock.quit).not.toHaveBeenCalled();
    });
    it('keeps a download started for the prompt running as a background download that ends ready', async () => {
      const api = await setupGate();
      let finish!: () => void;
      Object.assign(updater, { downloadUpdate: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
      updater.emit('update-available', { version: '0.6.0' });
      const progress = vi.fn();
      const running = api.startupDownload(progress);
      updater.emit('download-progress', { percent: 40, transferred: 4, total: 10, bytesPerSecond: 1 });
      expect(progress).toHaveBeenCalledWith(40);
      expect(api.getUpdateState()).toMatchObject({ status: 'downloading', percent: 40 });
      finish(); await running;
      updater.emit('update-downloaded', { version: '0.6.0' });
      expect(api.getUpdateState().status).toBe('ready');
    });
    it('reports a failed startup download as an update error', async () => {
      const api = await setupGate();
      Object.assign(updater, { downloadUpdate: vi.fn().mockRejectedValue(new Error('disk full')) });
      await expect(api.startupDownload(vi.fn())).rejects.toThrow('disk full');
      expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'disk full' });
    });
    it('hands over to the installer only for a downloaded update, hiding the startup window first', async () => {
      const api = await setupGate();
      const hide = vi.fn();
      expect(await api.startupHandoff(hide)).toBe(false);
      updater.emit('update-available', { version: '0.6.0' });
      updater.emit('update-downloaded', { version: '0.6.0' });
      mock.install.mockImplementationOnce(() => { expect(hide).toHaveBeenCalledOnce(); return true; });
      expect(await api.startupHandoff(hide)).toBe(true);
      expect(splash.show).toHaveBeenCalledExactlyOnceWith('0.6.0', strings);
      expect(mock.install).toHaveBeenCalledExactlyOnceWith(true, true);
      expect(mock.app.quit).toHaveBeenCalledOnce();
      expect(api.getUpdateState().status).toBe('installing');
      await api.startupHandoff(vi.fn());
      expect(mock.install).toHaveBeenCalledTimes(1);
    });
    it('does not report a hand-over when the installer did not start', async () => {
      const api = await setupGate();
      updater.emit('update-available', { version: '0.6.0' });
      updater.emit('update-downloaded', { version: '0.6.0' });
      mock.install.mockReturnValueOnce(false);
      expect(await api.startupHandoff(vi.fn())).toBe(false);
      expect(mock.app.quit).not.toHaveBeenCalled();
      expect(splash.abort).toHaveBeenCalledOnce();
      expect(api.getUpdateState().status).toBe('error');
    });
    it('reports a hand-over that throws', async () => {
      const api = await setupGate();
      updater.emit('update-available', { version: '0.6.0' });
      updater.emit('update-downloaded', { version: '0.6.0' });
      mock.install.mockImplementationOnce(() => { throw new Error('installer failed'); });
      expect(await api.startupHandoff(vi.fn())).toBe(false);
      expect(splash.abort).toHaveBeenCalledOnce();
    });
    it('does not start the stalled-download watchdog when an update is only announced', async () => {
      const api = await setupGate();
      updater.autoDownload = false;
      updater.emit('update-available', { version: '0.6.0' });
      expect(api.getUpdateState().status).toBe('idle');
    });
    it('ignores a finished download of a blocked version', async () => {
      const api = await setupGate();
      api.blockUpdateVersion('0.6.0');
      updater.emit('update-downloaded', { version: '0.6.0' });
      expect(api.getUpdateState().status).toBe('current');
      api.installNow();
      expect(mock.quit).not.toHaveBeenCalled();
      updater.emit('update-downloaded', { version: '0.7.0' });
      expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.7.0' });
    });
    it('stops the background check from downloading while a failed version is blocked, and resumes after', async () => {
      const api = await setupGate();
      expect(updater.autoDownload).toBe(true);
      api.blockUpdateVersion('0.6.0');
      expect(updater.autoDownload).toBe(false);
      mock.check.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: '0.5.8' } });
      await api.startupCheck();
      expect(updater.autoDownload).toBe(false);
      api.blockUpdateVersion(undefined);
      expect(updater.autoDownload).toBe(true);
    });
    it('withdraws an already downloaded version once it is blocked', async () => {
      const api = await setupGate();
      updater.emit('update-available', { version: '0.6.0' });
      updater.emit('update-downloaded', { version: '0.6.0' });
      api.blockUpdateVersion('0.6.0');
      expect(api.getUpdateState().status).toBe('current');
    });
  });
  describe('update window', () => {
    const setupWindow = async () => { const api = await import('../src/main/updater'); const changed = vi.fn(); api.initUpdater(changed, { strings: () => strings }); return { ...api, changed }; };
    it('stages the window runtime in the background once the update is downloaded', async () => {
      await setupWindow();
      updater.emit('update-downloaded', { version: '0.6.0' });
      expect(splash.stage).toHaveBeenCalledOnce();
    });
    it('does not stage anything without localized strings or for portable builds', async () => {
      await setup(); updater.emit('update-downloaded', { version: '0.6.0' });
      expect(splash.stage).not.toHaveBeenCalled();
      vi.resetModules(); vi.stubEnv('PORTABLE_EXECUTABLE_FILE', 'D:/app.exe');
      await setupWindow(); updater.emit('update-downloaded', { version: '0.6.0' });
      expect(splash.stage).not.toHaveBeenCalled();
    });
    it('shows the window before handing over to the installer, without the artificial pause', async () => {
      const api = await setupWindow();
      updater.emit('update-downloaded', { version: '0.6.0' });
      api.installNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(splash.show).toHaveBeenCalledExactlyOnceWith('0.6.0', strings);
      expect(mock.quit).toHaveBeenCalledExactlyOnceWith(true, true);
    });
    it('installs after the short pause when the window cannot be shown', async () => {
      splash.show.mockResolvedValueOnce(false);
      const api = await setupWindow();
      updater.emit('update-downloaded', { version: '0.6.0' });
      api.installNow();
      await vi.advanceTimersByTimeAsync(300);
      expect(mock.quit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(mock.quit).toHaveBeenCalledExactlyOnceWith(true, true);
    });
    it('closes the window again when the installer hand-off fails', async () => {
      const api = await setupWindow();
      updater.emit('update-downloaded', { version: '0.6.0' });
      mock.quit.mockImplementationOnce(() => { throw new Error('installer failed'); });
      api.installNow(); await vi.advanceTimersByTimeAsync(0);
      expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'installer failed' });
      expect(splash.abort).toHaveBeenCalledOnce();
    });
    it('treats a crashing window as unavailable and still installs', async () => {
      splash.show.mockRejectedValueOnce(new Error('spawn failed'));
      const api = await setupWindow();
      updater.emit('update-downloaded', { version: '0.6.0' });
      api.installNow(); await vi.advanceTimersByTimeAsync(400);
      expect(mock.quit).toHaveBeenCalledExactlyOnceWith(true, true);
    });
  });
});
