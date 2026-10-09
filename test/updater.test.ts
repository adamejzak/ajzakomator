import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ app: { isPackaged: true, once: vi.fn() }, check: vi.fn(), quit: vi.fn(), install: vi.fn() }));
vi.mock('electron', () => ({ app: mock.app }));
let updater: EventEmitter & { autoDownload: boolean; autoInstallOnAppQuit: boolean; checkForUpdates: typeof mock.check; quitAndInstall: typeof mock.quit; install: typeof mock.install };
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
    api.installNow(); api.installOnQuit();
    expect(mock.quit).not.toHaveBeenCalled(); expect(mock.install).not.toHaveBeenCalled();
  });
  it('uses manual updates on macOS without requiring portable environment flags', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    const api = await setup();
    expect(updater.autoDownload).toBe(false);
    updater.emit('update-available', { version: '0.5.0' });
    updater.emit('download-progress', { percent: 50, transferred: 50, total: 100, bytesPerSecond: 10 });
    updater.emit('update-downloaded', { version: '0.5.0' });
    expect(api.getUpdateState()).toMatchObject({ status: 'available', portable: true, url: api.RELEASES_URL });
    api.installNow(); api.installOnQuit();
    expect(mock.quit).not.toHaveBeenCalled(); expect(mock.install).not.toHaveBeenCalled();
  });
  it('exposes disabled development checks', async () => {
    mock.app.isPackaged = false;
    const api = await setup(); await api.checkForUpdates();
    expect(api.getUpdateState().status).toBe('error'); expect(mock.check).not.toHaveBeenCalled();
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
  it('reports silent-install failure and returns a defensive state snapshot', async () => {
    const api = await setup();
    updater.emit('update-downloaded', { version: '0.5.0' });
    const snapshot = api.getUpdateState(); snapshot.status = 'idle';
    expect(api.getUpdateState().status).toBe('ready');
    mock.install.mockReturnValueOnce(false);
    api.installOnQuit();
    expect(api.getUpdateState().status).toBe('error');
    expect(mock.install).toHaveBeenCalledExactlyOnceWith(true, false);
  });
});
