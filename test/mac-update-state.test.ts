import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_MESSAGES, REFUSAL_MESSAGES, type MacOffer, type MacStaged } from '../src/main/macUpdate/engine';

const mock = vi.hoisted(() => ({
  app: { isPackaged: true, once: vi.fn(), quit: vi.fn() },
  engine: { check: vi.fn(), download: vi.fn(), install: vi.fn(), finishPrevious: vi.fn(), markReady: vi.fn() },
  autoUpdaterTouched: vi.fn(),
}));
vi.mock('electron', () => ({ app: mock.app }));
vi.mock('electron-updater', () => ({ get autoUpdater() { mock.autoUpdaterTouched(); throw new Error('electron-updater must not be used on macOS'); } }));
vi.mock('../src/main/updateSplash', () => ({ showUpdateWindow: vi.fn(), stageSplashRuntime: vi.fn(), abortUpdateWindow: vi.fn() }));
vi.mock('../src/main/macUpdate/runtime', () => ({ createMacUpdater: () => mock.engine }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const offer = (over: Partial<MacOffer> = {}): MacOffer => ({
  version: '0.7.0', asset: { name: 'unimux-0.7.0-mac-arm64.zip', sha512: 'x', size: 100 }, url: 'https://example.test/a.zip', ...over,
});
const staged: MacStaged = { version: '0.7.0', bundle: '/s/extracted-0.7.0/unimux.app', executable: 'unimux', zip: '/s/a.zip', extractDir: '/s/extracted-0.7.0' };

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
  vi.stubEnv('PORTABLE_EXECUTABLE_FILE', '');
  vi.stubEnv('PORTABLE_EXECUTABLE_DIR', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mock.app.isPackaged = true;
  mock.engine.check.mockResolvedValue({ latest: '0.6.5' });
  mock.engine.download.mockResolvedValue(staged);
  mock.engine.install.mockResolvedValue({ ok: true });
  mock.engine.finishPrevious.mockResolvedValue({ kind: 'none' });
  mock.engine.markReady.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platformDescriptor); });

const setup = async () => { const api = await import('../src/main/updater'); const changed = vi.fn(); api.initUpdater(changed, { strings: () => ({}) as never }); return { ...api, changed }; };
/** Lets the background download that a check started run to its end (the mocked engine answers at once). */
const settle = () => vi.advanceTimersByTimeAsync(0);
const statuses = (changed: ReturnType<typeof vi.fn>) => changed.mock.calls.map(([s]) => (s as { status: string }).status);

describe('macOS updater state machine', () => {
  it('never touches electron-updater, is not portable and never installs by itself', async () => {
    const api = await setup();
    expect(api.isPortableBuild()).toBe(false);
    mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
    await api.checkForUpdates();
    await api.startupCheck();
    api.blockUpdateVersion('0.7.0'); api.blockUpdateVersion(undefined);
    await settle();
    expect(mock.autoUpdaterTouched).not.toHaveBeenCalled();
    expect(mock.engine.install).not.toHaveBeenCalled();
    expect(mock.app.quit).not.toHaveBeenCalled();
  });

  it('reports "current" with the version the feed announces', async () => {
    const api = await setup();
    await api.checkForUpdates();
    expect(api.getUpdateState()).toMatchObject({ status: 'current', version: '0.6.5' });
    expect(api.getUpdateState().checkedAt).toBeTypeOf('number');
  });

  it('checks -> downloading (with progress) -> ready, like the Windows background update', async () => {
    const api = await setup();
    mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
    mock.engine.download.mockImplementationOnce(async (_offer: MacOffer, onProgress: (p: unknown) => void) => {
      onProgress({ percent: 150, transferred: 100, total: 100, bytesPerSecond: 50 });
      expect(api.getUpdateState()).toMatchObject({ status: 'downloading', version: '0.7.0', percent: 100, transferred: 100, total: 100, bytesPerSecond: 50 });
      return staged;
    });
    await api.checkForUpdates();
    await settle();
    expect(statuses(api.changed)).toEqual(['checking', 'available', 'downloading', 'downloading', 'ready']);
    expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.7.0' });
    expect(api.getUpdateState().portable).toBeFalsy();
  });

  it('does not repeat a finished download on the next check', async () => {
    const api = await setup();
    mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
    await api.checkForUpdates(); await settle();
    expect(api.getUpdateState().status).toBe('ready');
    await api.checkForUpdates(); await settle();
    expect(mock.engine.download).toHaveBeenCalledTimes(1);
    expect(api.getUpdateState().status).toBe('ready');
  });

  it('falls back to the download page when the app cannot replace itself, with the reason', async () => {
    const api = await setup();
    mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer({ refusal: 'read-only' }) });
    await api.checkForUpdates();
    expect(api.getUpdateState()).toMatchObject({ status: 'available', version: '0.7.0', portable: true, url: api.RELEASES_URL, message: REFUSAL_MESSAGES['read-only'] });
    expect(mock.engine.download).not.toHaveBeenCalled();
    expect(api.canInstallNow()).toBe(false);
    expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
    expect(mock.engine.install).not.toHaveBeenCalled();
    expect(mock.app.quit).not.toHaveBeenCalled();
  });

  it('shows a download error and lets the next check try again', async () => {
    const api = await setup();
    mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
    mock.engine.download.mockRejectedValueOnce(new Error(MAC_MESSAGES.damaged));
    await api.checkForUpdates(); await settle();
    expect(api.getUpdateState()).toMatchObject({ status: 'error', message: MAC_MESSAGES.damaged, version: '0.7.0' });
    await api.checkForUpdates(); await settle();
    expect(api.getUpdateState().status).toBe('ready');
    expect(mock.engine.download).toHaveBeenCalledTimes(2);
  });

  it('shows a check error (offline) as an update error', async () => {
    const api = await setup();
    mock.engine.check.mockRejectedValueOnce(new Error('offline'));
    await api.checkForUpdates();
    expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'offline' });
  });

  it('keeps a long unpacking phase alive (the engine itself limits silent downloads)', async () => {
    const api = await setup();
    mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
    let finish!: (value: MacStaged) => void;
    mock.engine.download.mockImplementationOnce(() => new Promise<MacStaged>((resolve) => { finish = resolve; }));
    await api.checkForUpdates();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(api.getUpdateState().status).toBe('downloading');
    finish(staged); await settle();
    expect(api.getUpdateState().status).toBe('ready');
  });

  describe('install', () => {
    const ready = async () => {
      const api = await setup();
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState().status).toBe('ready');
      return api;
    };
    it('ready -> installing -> script started -> hides the window, quits through the normal quit path, once', async () => {
      const api = await ready();
      const hide = vi.fn();
      mock.app.quit.mockImplementationOnce(() => { expect(hide).toHaveBeenCalledOnce(); expect(mock.engine.install).toHaveBeenCalledOnce(); });
      expect(await api.handOver('0.7.0', hide)).toBe(true);
      expect(await api.handOver('0.7.0', hide)).toBe(false);
      expect(mock.engine.install).toHaveBeenCalledExactlyOnceWith(staged);
      expect(mock.app.quit).toHaveBeenCalledOnce();
      expect(api.updateHandoffStarted()).toBe(true);
      expect(api.getUpdateState()).toMatchObject({ status: 'installing', version: '0.7.0' });
    });
    it('reports an app that did not quit within the watchdog time', async () => {
      const api = await ready();
      await api.handOver('0.7.0', vi.fn());
      await vi.advanceTimersByTimeAsync(30 * 1000);
      expect(api.getUpdateState()).toMatchObject({ status: 'error', message: MAC_MESSAGES.quitTimeout });
      expect(api.updateHandoffStarted()).toBe(false);
    });
    it('does not quit when the script cannot be started', async () => {
      const api = await ready();
      mock.engine.install.mockRejectedValueOnce(new Error(MAC_MESSAGES.spawn));
      expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
      expect(mock.app.quit).not.toHaveBeenCalled();
      expect(api.getUpdateState()).toMatchObject({ status: 'error', message: MAC_MESSAGES.spawn });
    });
    it('falls back to the download page when the install is refused at the last moment', async () => {
      const api = await ready();
      mock.engine.install.mockResolvedValueOnce({ ok: false, refusal: 'app-management' });
      expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
      expect(mock.app.quit).not.toHaveBeenCalled();
      expect(api.getUpdateState()).toMatchObject({ status: 'available', version: '0.7.0', portable: true, url: api.RELEASES_URL, message: REFUSAL_MESSAGES['app-management'] });
      expect(api.updateHandoffStarted()).toBe(false);
      expect(api.canInstallNow()).toBe(false);
    });
    it('keeps the download page offer when the gate records the refused install as a failure (block)', async () => {
      const api = await ready();
      mock.engine.install.mockResolvedValueOnce({ ok: false, refusal: 'app-management' });
      expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
      api.blockUpdateVersion('0.7.0');
      expect(api.getUpdateState()).toMatchObject({ status: 'available', version: '0.7.0', portable: true, url: api.RELEASES_URL, message: REFUSAL_MESSAGES['app-management'] });
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState()).toMatchObject({ status: 'available', portable: true });
      expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
    });
    it('abandons the hand-over when the deadline passed before the script was started, and does not touch electron-updater', async () => {
      const api = await ready();
      const deadline = new AbortController(); deadline.abort();
      expect(await api.handOver('0.7.0', vi.fn(), deadline.signal)).toBe(false);
      expect(mock.engine.install).not.toHaveBeenCalled();
      expect(api.getUpdateState()).toMatchObject({ status: 'error', version: '0.7.0' });
      expect(api.updateHandoverCommitted()).toBe(false);
      expect(mock.autoUpdaterTouched).not.toHaveBeenCalled();
    });
    it('installs nothing unless an update is ready, and never another version than the target', async () => {
      const api = await setup();
      expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
      const ok = await ready();
      expect(await ok.handOver('0.6.9', vi.fn())).toBe(false);
      expect(mock.engine.install).not.toHaveBeenCalled();
    });
  });

  describe('failure cooldown and blocked versions', () => {
    it('does not download a version that failed before, in the background check', async () => {
      const api = await setup();
      api.blockUpdateVersion('0.7.0');
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
      await api.checkForUpdates(); await settle();
      expect(mock.engine.download).not.toHaveBeenCalled();
      expect(api.getUpdateState().status).toBe('current');
      expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
      expect(mock.engine.install).not.toHaveBeenCalled();
    });
    it('ignores a download that finishes after its version was blocked', async () => {
      const api = await setup();
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
      let finish!: (value: MacStaged) => void;
      mock.engine.download.mockImplementationOnce(() => new Promise<MacStaged>((resolve) => { finish = resolve; }));
      await api.checkForUpdates(); await settle();
      api.blockUpdateVersion('0.7.0');
      expect(api.getUpdateState().status).toBe('current');
      finish(staged); await settle();
      expect(api.getUpdateState().status).toBe('current');
      expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
      expect(mock.engine.install).not.toHaveBeenCalled();
    });
    it('downloads again once the block is lifted', async () => {
      const api = await setup();
      api.blockUpdateVersion('0.7.0'); api.blockUpdateVersion(undefined);
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState().status).toBe('ready');
    });
  });

  describe('newer release (same supersede rule as Windows)', () => {
    const offerFor = (version: string) => offer({ version, asset: { name: `unimux-${version}-mac-arm64.zip`, sha512: 'x', size: 100 } });
    const stagedFor = (version: string): MacStaged => ({ ...staged, version });
    it('cancels the running download of the old version and downloads the newer one', async () => {
      const api = await setup();
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offerFor('0.7.0') });
      const signals: AbortSignal[] = [];
      mock.engine.download.mockImplementationOnce((_o: MacOffer, _p: unknown, signal: AbortSignal) => new Promise<MacStaged>((_resolve, reject) => {
        signals.push(signal); signal.addEventListener('abort', () => reject(new Error('download cancelled')));
      }));
      await api.checkForUpdates(); await settle();
      expect(api.getUpdateState()).toMatchObject({ status: 'downloading', version: '0.7.0' });
      mock.engine.check.mockResolvedValue({ latest: '0.7.1', offer: offerFor('0.7.1') });
      mock.engine.download.mockResolvedValueOnce(stagedFor('0.7.1'));
      await api.checkForUpdates('background'); await settle();
      expect(signals[0].aborted).toBe(true);
      expect(api.getUpdateState()).toMatchObject({ status: 'ready', version: '0.7.1' });
      expect(await api.handOver('0.7.1', vi.fn())).toBe(true);
      expect(mock.engine.install).toHaveBeenCalledExactlyOnceWith(stagedFor('0.7.1'));
    });
  });

  describe('start-up gate helpers', () => {
    it('checks, then the download for the prompt starts at once and ends ready', async () => {
      const api = await setup();
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
      expect(await api.startupCheck()).toEqual({ version: '0.7.0' });
      await settle();
      expect(mock.engine.download).toHaveBeenCalledTimes(1);
      mock.engine.check.mockResolvedValue({ latest: '0.6.5' });
      expect(await api.startupCheck()).toBeUndefined();
      mock.engine.check.mockRejectedValueOnce(new Error('offline'));
      await expect(api.startupCheck()).rejects.toThrow('offline');
    });
    it('offers nothing it cannot install (refusal shows the download link in the status bar instead)', async () => {
      const api = await setup();
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer({ refusal: 'translocated' }) });
      expect(await api.startupCheck()).toBeUndefined();
      expect(api.getUpdateState()).toMatchObject({ status: 'available', portable: true });
    });
    it('reports progress to the prompt; a second caller shares the one download', async () => {
      const api = await setup();
      let finish!: (value: MacStaged) => void;
      let report!: (p: unknown) => void;
      mock.engine.download.mockImplementationOnce((_o: MacOffer, onProgress: (p: unknown) => void) => { report = onProgress; return new Promise<MacStaged>((resolve) => { finish = resolve; }); });
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
      await api.startupCheck(); await settle();
      const progress = vi.fn();
      const running = api.startupDownload(progress);
      const second = api.startupDownload(vi.fn());
      report({ percent: 40, transferred: 40, total: 100, bytesPerSecond: 1 });
      expect(progress).toHaveBeenCalledWith(40);
      finish(staged); await Promise.all([running, second]);
      expect(mock.engine.download).toHaveBeenCalledTimes(1);
      expect(api.getUpdateState().status).toBe('ready');
    });
    it('fails the start-up download visibly and rethrows (the gate records the failure)', async () => {
      const api = await setup();
      mock.engine.download.mockRejectedValueOnce(new Error('disk full'));
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
      await api.startupCheck();
      await expect(api.startupDownload(vi.fn())).rejects.toThrow('disk full');
      expect(api.getUpdateState()).toMatchObject({ status: 'error', message: 'disk full' });
    });
    it('hand-over does not quit when the script did not start', async () => {
      const api = await setup();
      mock.engine.check.mockResolvedValue({ latest: '0.7.0', offer: offer() });
      await api.startupCheck(); await api.startupDownload(vi.fn());
      mock.engine.install.mockResolvedValueOnce({ ok: false, refusal: 'not-writable' });
      expect(await api.handOver('0.7.0', vi.fn())).toBe(false);
      expect(mock.app.quit).not.toHaveBeenCalled();
    });
  });

  describe('start-up bookkeeping', () => {
    it('reports how the previous update ended and releases the waiting script', async () => {
      const api = await setup();
      mock.engine.finishPrevious.mockResolvedValueOnce({ kind: 'failed', version: '0.7.0' });
      expect(await api.previousMacUpdate()).toEqual({ kind: 'failed', version: '0.7.0' });
      api.signalMacUpdateReady();
      expect(mock.engine.markReady).toHaveBeenCalledOnce();
    });
    it('shows the existing failure feedback when the previous update was rolled back', async () => {
      const api = await setup();
      mock.engine.finishPrevious.mockResolvedValueOnce({ kind: 'failed', version: '0.7.0' });
      await api.previousMacUpdate();
      expect(api.getUpdateState()).toMatchObject({ status: 'error', version: '0.7.0', message: MAC_MESSAGES.rolledBack });
    });
    it('is a no-op on other platforms and in development', async () => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      vi.resetModules();
      const api = await import('../src/main/updater');
      expect(await api.previousMacUpdate()).toEqual({ kind: 'none' });
      api.signalMacUpdateReady();
      expect(mock.engine.finishPrevious).not.toHaveBeenCalled();
      expect(mock.engine.markReady).not.toHaveBeenCalled();
    });
    it('does not check updates in an unpackaged build', async () => {
      mock.app.isPackaged = false;
      const api = await setup();
      await api.checkForUpdates();
      expect(api.getUpdateState().status).toBe('unavailable');
      expect(mock.engine.check).not.toHaveBeenCalled();
      expect(await api.previousMacUpdate()).toEqual({ kind: 'none' });
    });
    it('checks in the background shortly after start and then periodically', async () => {
      await setup();
      await vi.advanceTimersByTimeAsync(8000);
      expect(mock.engine.check).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(mock.engine.check).toHaveBeenCalledTimes(2);
    });
  });
});
