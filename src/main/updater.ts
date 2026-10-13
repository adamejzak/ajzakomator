import { app } from 'electron';
import { join } from 'path';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/types';
import type { UpdateStrings } from '../shared/updateProgress';
import { abortUpdateWindow, showUpdateWindow, stageSplashRuntime } from './updateSplash';
import { createUpdaterLogger } from './updaterLog';
import { MAC_MESSAGES, REFUSAL_MESSAGES, type MacOffer, type MacPreviousOutcome, type MacStaged, type MacUpdater } from './macUpdate/engine';
import { createMacUpdater } from './macUpdate/runtime';

export const RELEASES_URL = 'https://github.com/adamejzak/ajzakomator/releases/latest';
const CHECK_EVERY_MS = 30 * 60 * 1000;
const STALL_MS = 2 * 60 * 1000;
/** After the macOS update script was started the app must be gone within this time (its own wind-down is limited to 20 s). */
const MAC_QUIT_WATCHDOG_MS = 30 * 1000;
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

// â”€â”€ macOS: our own updater (electron-updater / Squirrel.Mac rejects ad-hoc signed updates and is never touched there) â”€â”€
const isMac = (): boolean => process.platform === 'darwin';
let mac: MacUpdater | undefined;
let macOffer: MacOffer | undefined;
let macStaged: MacStaged | undefined;
let macDownloading: { version: string; promise: Promise<void> } | undefined;
const macListeners = new Set<(percent: number) => void>();
const macEngine = (): MacUpdater => (mac ??= createMacUpdater(devFeed, (line) => console.log('mac-update:', line)));

function set(next: UpdateState): void {
  clearTimeout(watchdog);
  state = { ...next, portable: next.portable ?? portable };
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
    if (isMac()) { await macBackgroundCheck(); return; }
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
  portable = !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
  state = { ...state, portable };
  if (!updatesActive()) return;
  if (!isMac()) wireElectronUpdater();
  const check = () => void checkForUpdates();
  // The start-up check may have just asked the feed; do not repeat it seconds later.
  const first = setTimeout(() => { if (Date.now() - (state.checkedAt ?? 0) > 60_000) check(); }, 8000);
  const recurring = setInterval(check, CHECK_EVERY_MS);
  first.unref?.();
  recurring.unref?.();
  app.once('before-quit', () => { clearTimeout(first); clearInterval(recurring); clearTimeout(watchdog); });
}

/** The Windows (installed) and portable updater: electron-updater events drive the state. */
function wireElectronUpdater(): void {
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
    if (isMac()) {
      // The short pause lets the renderer paint the installing state before the app starts winding down.
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (await macInstallStaged()) macQuit();
      return;
    }
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

/** True for portable builds, which never install on their own (macOS reports itself as such only when it cannot replace itself). */
export const isPortableBuild = (): boolean => portable;

/** Looks for an update without downloading it; the caller decides whether to wait for the download. */
export async function startupCheck(): Promise<{ version: string } | undefined> {
  if (!updatesActive() || portable) return undefined;
  if (isMac()) return macStartupCheck();
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
  if (initialized && updatesActive() && !isMac()) autoUpdater.autoDownload = autoDownloadWanted();
  if (version && state.version === version && ['downloading', 'ready', 'idle'].includes(state.status)) set({ status: 'current', checkedAt: Date.now() });
}

/** Marks the startup check as given up, so a late answer is handled like a background check. */
export function abandonStartupCheck(): void { startupAbandoned = true; }

/**
 * Downloads the update found by `startupCheck`, reporting percentages. The gate starts it as soon as the
 * update is offered, so it may keep running as an ordinary background download after the user chose "Later".
 */
export async function startupDownload(onProgress: (percent: number) => void): Promise<void> {
  if (isMac()) {
    const offer = macOffer;
    if (!offer || offer.refusal) throw new Error(MAC_MESSAGES.noAsset);
    macListeners.add(onProgress);
    try { await macDownload(offer); } finally { macListeners.delete(onProgress); }
    return;
  }
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
  if (isMac()) {
    if (!(await macInstallStaged())) return false;
    hide();
    app.quit();
    return true;
  }
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

// â”€â”€ macOS flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

/** The app cannot replace itself here: behave like a portable build (status "available" with the download page). */
function macRefused(offer: MacOffer): void {
  set({ status: 'available', version: offer.version, url: RELEASES_URL, message: offer.refusal ? REFUSAL_MESSAGES[offer.refusal] : undefined, portable: true });
}

/** Asks the feed and publishes what it found; the offer (if any) is remembered for the download. */
async function macLookup(): Promise<MacOffer | undefined> {
  const { latest, offer } = await macEngine().check();
  macOffer = offer;
  if (!offer) { set({ status: 'current', version: latest, checkedAt: Date.now() }); return undefined; }
  if (offer.refusal) { macRefused(offer); return undefined; }
  // Without a download in progress nothing is transferring, so no stalled-download watchdog may start.
  set({ status: 'idle', version: offer.version });
  return offer;
}

/** Scheduled and manual checks: like electron-updater's, they download by themselves unless a failed version is blocked. */
async function macBackgroundCheck(): Promise<void> {
  try {
    const offer = await macLookup();
    if (offer && autoDownloadWanted() && offer.version !== blockedVersion) await macDownload(offer).catch(() => { /* reported by macDownload */ });
  } catch (error) { fail(error); }
}

async function macStartupCheck(): Promise<{ version: string } | undefined> {
  try {
    const offer = await macLookup();
    if (!offer) return undefined;
    // The gate gave up while this check was running: continue as a normal background update.
    if (startupAbandoned && offer.version !== blockedVersion) void macDownload(offer).catch(() => { /* reported by macDownload */ });
    return { version: offer.version };
  } catch (error) { fail(error); throw error; }
  finally { startupAbandoned = false; }
}

/** One download at a time per version; later callers (gate and background) share it. Ends in "ready" or "error". */
function macDownload(offer: MacOffer): Promise<void> {
  if (macStaged?.version === offer.version) {
    if (!['ready', 'installing'].includes(state.status)) set({ status: 'ready', version: offer.version });
    return Promise.resolve();
  }
  if (macDownloading?.version === offer.version) return macDownloading.promise;
  const promise = (async () => {
    set({ status: 'downloading', version: offer.version, percent: 0 });
    // Unpacking and verifying produce no progress; keep the stalled-download watchdog from firing during it.
    const beat = setInterval(() => { if (state.status === 'downloading') set({ ...state }); }, 20_000);
    beat.unref?.();
    try {
      const staged = await macEngine().download(offer, (p) => {
        const percent = clampPercent(p.percent);
        for (const listener of macListeners) listener(percent);
        if (!['ready', 'installing'].includes(state.status)) {
          set({ status: 'downloading', version: offer.version, percent, transferred: Math.max(0, p.transferred), total: Math.max(0, p.total), bytesPerSecond: Math.max(0, p.bytesPerSecond) });
        }
      });
      if (offer.version === blockedVersion) { set({ status: 'current', checkedAt: Date.now() }); return; }
      macStaged = staged;
      set({ status: 'ready', version: offer.version });
    } catch (error) { fail(error); throw error; }
    finally { clearInterval(beat); macDownloading = undefined; }
  })();
  macDownloading = { version: offer.version, promise };
  return promise;
}

/** Writes and starts the swap script. False means nothing was handed over (the state already says why). */
async function macInstallStaged(): Promise<boolean> {
  const staged = macStaged;
  if (!staged) { fail(new Error(MAC_MESSAGES.verify)); return false; }
  try {
    const result = await macEngine().install(staged);
    if (result.ok) return true;
    // The app turned out not to be replaceable (for example macOS denied App Management): offer the download page.
    installStarted = false;
    macRefused({ version: staged.version, asset: macOffer?.asset ?? { name: '', sha512: '', size: 0 }, url: macOffer?.url ?? '', refusal: result.refusal });
  } catch (error) { fail(error); }
  return false;
}

/** The script waits for this process; the normal quit path winds the terminals down (and exits within its hard limit). */
function macQuit(): void {
  const timer = setTimeout(() => fail(new Error(MAC_MESSAGES.quitTimeout)), MAC_QUIT_WATCHDOG_MS);
  timer.unref?.();
  app.quit();
}

/** At start: how the previous update ended (only ever not "none" on macOS); a failure is for the caller to remember. */
export async function previousMacUpdate(): Promise<MacPreviousOutcome> {
  if (!isMac() || !updatesActive()) return { kind: 'none' };
  try {
    const outcome = await macEngine().finishPrevious();
    // The existing failure feedback: the status bar shows the error until the next check (the failure itself is recorded by the caller).
    if (outcome.kind === 'failed') set({ status: 'error', version: outcome.version, message: MAC_MESSAGES.rolledBack });
    return outcome;
  } catch { return { kind: 'none' }; }
}

/** The main window of this version is up: releases the waiting update script and cleans up (macOS only). */
export function signalMacUpdateReady(): void {
  if (!isMac() || !updatesActive()) return;
  void macEngine().markReady().catch(() => { /* the script gives up waiting on its own */ });
}
