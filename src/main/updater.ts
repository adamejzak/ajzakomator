import { app } from 'electron';
import { join } from 'path';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/types';
import type { UpdateStrings } from '../shared/updateProgress';
import { abortUpdateWindow, showUpdateWindow, stageSplashRuntime } from './updateSplash';
import { createUpdaterLogger } from './updaterLog';

export const RELEASES_URL = 'https://github.com/adamejzak/ajzakomator/releases/latest';
const CHECK_EVERY_MS = 30 * 60 * 1000;
const STALL_MS = 2 * 60 * 1000;
let state: UpdateState = { status: 'idle' };
let emit: (s: UpdateState) => void = () => {};
let initialized = false;
let portable = false;
let pending: Promise<void> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let getStrings: (() => UpdateStrings) | undefined;
let startupAbandoned = false;
/** Set once an installer was started for this run; nothing may start a second one for the same update. */
let installStarted = false;
/** Whether an installer has been started in this run (and has not failed to start). */
export const updateHandoffStarted = (): boolean => installStarted;
/** A version that failed to update; it never becomes "ready", so no quit or button path installs it again. */
let blockedVersion: string | undefined;
/** Development only: a generic update feed (for example a local server) lets the updater be exercised from an unpackaged build. */
const devFeed = !app.isPackaged ? process.env.MC_UPDATE_FEED : undefined;
const updatesActive = (): boolean => app.isPackaged || !!devFeed;
/** Background checks download by themselves, except for portable builds and while a failed version is blocked. */
const autoDownloadWanted = (): boolean => !portable && !blockedVersion;

function set(next: UpdateState): void {
  clearTimeout(watchdog);
  state = { ...next, portable };
  emit(state);
  if (next.status === 'checking' || next.status === 'downloading') {
    watchdog = setTimeout(() => fail(new Error('Brak odpowiedzi serwera aktualizacji. Spróbuj ponownie.')), STALL_MS);
    watchdog.unref?.();
  }
}

function fail(error: unknown): void {
  installStarted = false;
  console.error('auto-update failed', error);
  const message = error instanceof Error ? error.message : String(error);
  set({ status: 'error', version: state.version, message: message || 'Nie udało się sprawdzić aktualizacji.' });
}

/** Shared entry point for manual and scheduled checks. */
export async function checkForUpdates(): Promise<void> {
  if (pending || ['checking', 'downloading', 'ready', 'installing'].includes(state.status)) {
    emit(state);
    return pending;
  }
  if (!updatesActive()) {
    set({ status: 'unavailable', message: 'Aktualizacje są dostępne w zainstalowanej aplikacji.' });
    return;
  }
  set({ status: 'checking' });
  pending = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) fail(new Error('Nie udało się uruchomić sprawdzania aktualizacji.'));
      result?.downloadPromise?.catch(fail);
    } catch (error) { fail(error); }
  })();
  try { await pending; } finally { pending = undefined; }
}

export function getUpdateState(): UpdateState { return { ...state }; }

export interface UpdaterHooks {
  /** Localizes the detached update window (the footer differs by mode); without it installation stays invisible as before. */
  strings?: () => UpdateStrings;
}

export function initUpdater(onChange: (s: UpdateState) => void, hooks: UpdaterHooks = {}): void {
  emit = onChange;
  getStrings = hooks.strings;
  if (initialized) { emit(state); return; }
  initialized = true;
  portable = !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) || process.platform === 'darwin';
  state = { ...state, portable };
  if (!updatesActive()) return;
  if (devFeed) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: 'generic', url: devFeed }); }
  autoUpdater.autoDownload = autoDownloadWanted();
  autoUpdater.autoInstallOnAppQuit = false;
  // A proxy or CDN in between must not answer with an older copy of the release feed.
  autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
  try { autoUpdater.logger = createUpdaterLogger(join(app.getPath('userData'), 'updater.log')); } catch { /* the logger is optional */ }
  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-not-available', (info) => set({ status: 'current', version: info?.version, checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => set(portable
    ? { status: 'available', version: info.version, url: RELEASES_URL }
    // Without auto download (the startup check) nothing is transferring yet, so no stalled-download watchdog may start.
    : autoUpdater.autoDownload
      ? { status: 'downloading', version: info.version, percent: 0 }
      : { status: 'idle', version: info.version }));
  autoUpdater.on('download-progress', (p) => {
    if (!portable && !['ready', 'installing'].includes(state.status)) set({
      status: 'downloading', version: state.version,
      percent: Math.min(100, Math.max(0, Number.isFinite(p.percent) ? p.percent : 0)),
      transferred: Math.max(0, p.transferred || 0), total: Math.max(0, p.total || 0),
      bytesPerSecond: Math.max(0, p.bytesPerSecond || 0),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    if (portable) return;
    if (info.version === blockedVersion) { set({ status: 'current', checkedAt: Date.now() }); return; }
    set({ status: 'ready', version: info.version });
    if (getStrings) void stageSplashRuntime();
  });
  autoUpdater.on('error', fail);
  const check = () => void checkForUpdates();
  const first = setTimeout(check, 8000);
  const recurring = setInterval(check, CHECK_EVERY_MS);
  first.unref?.();
  recurring.unref?.();
  app.once('before-quit', () => { clearTimeout(first); clearInterval(recurring); clearTimeout(watchdog); });
}

/** Shows the progress window; false means installation proceeds without it. */
async function showWindow(): Promise<boolean> {
  if (!getStrings || !state.version) return false;
  try { return await showUpdateWindow(state.version, getStrings()); }
  catch (error) { console.error('update window failed', error); return false; }
}

export function installNow(): void {
  if (portable || state.status !== 'ready' || installStarted) return;
  installStarted = true;
  set({ ...state, status: 'installing' });
  void (async () => {
    const shown = await showWindow();
    // Without the window, keep the short pause that lets the renderer paint the installing state.
    if (!shown) await new Promise((resolve) => setTimeout(resolve, 400));
    try { autoUpdater.quitAndInstall(true, true); }
    catch (error) { fail(error); if (shown) void abortUpdateWindow(); }
  })();
}

// ── startup gate: the same updater, driven before the main window exists ─────────────────────────

/** Whether updates can run at all (installed build, or a development feed). */
export const updatesEnabled = updatesActive;

/** True for portable and macOS builds, which never install on their own. */
export const isPortableBuild = (): boolean => portable;

/** Looks for an update without downloading it; the caller decides whether to wait for the download. */
export async function startupCheck(): Promise<{ version: string } | undefined> {
  if (!updatesActive() || portable) return undefined;
  autoUpdater.autoDownload = false;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) return undefined;
    const version = result.updateInfo.version;
    // The gate gave up while this check was running: continue as a normal background update.
    if (startupAbandoned && version !== blockedVersion) void autoUpdater.downloadUpdate().catch(fail);
    return { version };
  } finally {
    autoUpdater.autoDownload = autoDownloadWanted();
    startupAbandoned = false;
  }
}

/** Never installs `version` again in this run (it failed before); a finished download of it is ignored. */
export function blockUpdateVersion(version: string | undefined): void {
  blockedVersion = version;
  // A version that already failed must not be fetched again by the regular background check on every launch.
  if (initialized && updatesActive()) autoUpdater.autoDownload = autoDownloadWanted();
  if (version && state.version === version && ['downloading', 'ready', 'idle'].includes(state.status)) set({ status: 'current', checkedAt: Date.now() });
}

/** Marks the startup check as given up, so a late answer is handled like a background check. */
export function abandonStartupCheck(): void { startupAbandoned = true; }

/**
 * Downloads the update found by `startupCheck`, reporting percentages. The gate starts it as soon as the
 * update is offered, so it may keep running as an ordinary background download after the user chose "Later".
 */
export async function startupDownload(onProgress: (percent: number) => void): Promise<void> {
  const listener = (p: { percent: number }) => onProgress(p.percent);
  autoUpdater.on('download-progress', listener);
  set({ status: 'downloading', version: state.version, percent: 0 });
  // The private runtime of the update window is copied while the download runs, not after it (saves the copy time at hand-over).
  if (getStrings) void stageSplashRuntime();
  try { await autoUpdater.downloadUpdate(); }
  catch (error) { fail(error); throw error; }
  finally { autoUpdater.removeListener('download-progress', listener); }
}

/**
 * Starts the detached installing window and the installer for a downloaded update. `hide` closes the
 * startup window once the installing window is visible. False means nothing was handed over.
 */
export async function startupHandoff(hide: () => void): Promise<boolean> {
  if (portable || state.status !== 'ready' || installStarted) return false;
  installStarted = true;
  set({ ...state, status: 'installing' });
  const shown = await showWindow();
  hide();
  // install() reports whether the installer started; quitAndInstall would silently do nothing when it did not.
  try {
    const installed = (autoUpdater as unknown as { install(silent: boolean, relaunch: boolean): boolean }).install(true, true);
    if (installed) { app.quit(); return true; }
    fail(new Error('Nie udało się zainstalować aktualizacji.'));
  } catch (error) { fail(error); }
  if (shown) void abortUpdateWindow();
  return false;
}
