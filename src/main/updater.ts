import { app } from 'electron';
import { join } from 'path';
import { autoUpdater, CancellationToken, type ProgressInfo } from 'electron-updater';
import type { UpdateState } from '../shared/types';
import type { UpdateStrings } from '../shared/updateProgress';
import { abortUpdateWindow, showUpdateWindow, stageSplashRuntime } from './updateSplash';
import { createUpdaterLogger } from './updaterLog';
import { MAC_MESSAGES, REFUSAL_MESSAGES, type MacOffer, type MacPreviousOutcome, type MacStaged, type MacUpdater } from './macUpdate/engine';
import { createMacUpdater } from './macUpdate/runtime';
import { UpdateCoordinator, type UpdateBackend } from './updateCoordinator';

export const RELEASES_URL = 'https://github.com/adamejzak/ajzakomator/releases/latest';
const CHECK_EVERY_MS = 30 * 60 * 1000;
/** After the macOS update script was started the app must be gone within this time (its own wind-down is limited to 20 s). */
const MAC_QUIT_WATCHDOG_MS = 30 * 1000;
let emit: (s: UpdateState) => void = () => {};
let initialized = false;
let portable = false;
let getStrings: (() => UpdateStrings) | undefined;
/** Development only: a generic update feed (for example a local server) lets the updater be exercised from an unpackaged build. */
const devFeed = !app.isPackaged ? process.env.MC_UPDATE_FEED : undefined;
const updatesActive = (): boolean => app.isPackaged || !!devFeed;

const isMac = (): boolean => process.platform === 'darwin';

// ── macOS: our own updater (electron-updater / Squirrel.Mac rejects ad-hoc signed updates and is never touched there) ──
let mac: MacUpdater | undefined;
let macOffer: MacOffer | undefined;
let macStaged: MacStaged | undefined;
const macEngine = (): MacUpdater => (mac ??= createMacUpdater(devFeed, (line) => console.log('mac-update:', line)));

const macBackend: UpdateBackend = {
  // The engine stops silent transfers by itself; unpacking and verifying report no progress.
  selfWatched: true,
  async lookup() {
    const { latest, offer } = await macEngine().check();
    macOffer = offer;
    if (!offer) return { latest };
    // An app that cannot replace itself only gets the download page (reported with the reason).
    return { latest, update: { version: offer.version, manual: offer.refusal ? { message: REFUSAL_MESSAGES[offer.refusal] } : undefined } };
  },
  async download(version, onProgress, signal) {
    const offer = macOffer;
    if (!offer || offer.refusal || offer.version !== version) throw new Error(MAC_MESSAGES.noAsset);
    macStaged = undefined;
    macStaged = await macEngine().download(offer, onProgress, signal);
  },
};

// ── Windows (installed and portable): electron-updater, driven explicitly (it never downloads or installs by itself) ──
const windowsBackend: UpdateBackend = {
  async lookup() {
    const result = await autoUpdater.checkForUpdates();
    if (!result) throw new Error('Nie udało się uruchomić sprawdzania aktualizacji.');
    const version: string | undefined = result.updateInfo?.version;
    return result.isUpdateAvailable && version ? { latest: version, update: { version } } : { latest: version };
  },
  async download(_version, onProgress, signal) {
    const token = new CancellationToken();
    const cancel = () => token.cancel();
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    const listener = (p: ProgressInfo) => onProgress({ percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond });
    autoUpdater.on('download-progress', listener);
    try { await autoUpdater.downloadUpdate(token); }
    finally { autoUpdater.removeListener('download-progress', listener); signal.removeEventListener('abort', cancel); }
  },
};

const coordinator = new UpdateCoordinator({
  backend: {
    get selfWatched() { return isMac(); },
    lookup: () => (isMac() ? macBackend : windowsBackend).lookup(),
    download: (version, onProgress, signal) => (isMac() ? macBackend : windowsBackend).download(version, onProgress, signal),
  },
  emit: (state) => {
    // The private runtime of the update window is copied while the download runs, not after it (saves the copy time at hand-over).
    if (!isMac() && !portable && getStrings && (state.status === 'downloading' || state.status === 'ready')) void stageSplashRuntime();
    emit(state);
  },
  portable: () => portable,
  releasesUrl: RELEASES_URL,
});

/** Shared entry point for manual and scheduled checks. */
export async function checkForUpdates(reason: 'manual' | 'background' = 'manual'): Promise<void> {
  if (!updatesActive()) {
    coordinator.setStatus({ status: 'unavailable', message: 'Aktualizacje są dostępne w zainstalowanej aplikacji.' });
    return;
  }
  await coordinator.check(reason);
}

export function getUpdateState(): UpdateState { return coordinator.getState(); }

/** The version the update is heading for (the newest the feed announced), or undefined. */
export const updateTarget = (): string | undefined => coordinator.currentTarget();
/** Whether `version` is the target and fully downloaded. */
export const isUpdateDownloaded = (version: string): boolean => coordinator.isDownloaded(version);
/** Registers a callback for a newer release replacing the offered one; returns the unsubscribe. */
export const onUpdateTargetChange = (listener: () => void): (() => void) => coordinator.onTargetChange(listener);
/** A newer version seen after the hand-over started (offered after the relaunch). */
export const newerVersionAfterHandover = (): string | undefined => coordinator.newerVersion();
/** Whether the status bar button may open the update window: an in-app update is offered, downloading or downloaded. */
export function canInstallNow(): boolean {
  const state = coordinator.getState();
  return !portable && !state.portable && coordinator.installable() && ['available', 'downloading', 'ready'].includes(state.status);
}

export interface UpdaterHooks {
  /** Localizes the detached update window (the footer differs by mode); without it installation stays invisible as before. */
  strings?: () => UpdateStrings;
}

export function initUpdater(onChange: (s: UpdateState) => void, hooks: UpdaterHooks = {}): void {
  emit = onChange;
  getStrings = hooks.strings;
  if (initialized) { coordinator.publish(); return; }
  initialized = true;
  portable = !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);
  if (!updatesActive()) return;
  if (!isMac()) wireElectronUpdater();
  const check = () => void checkForUpdates('background');
  // The start-up check may have just asked the feed; do not repeat it seconds later.
  const first = setTimeout(() => { if (Date.now() - coordinator.lastCheckAt() > 60_000) check(); }, 8000);
  const recurring = setInterval(check, CHECK_EVERY_MS);
  first.unref?.();
  recurring.unref?.();
  app.once('before-quit', () => { clearTimeout(first); clearInterval(recurring); coordinator.dispose(); });
}

/** The Windows (installed) and portable updater: the coordinator asks electron-updater for lookups and downloads. */
function wireElectronUpdater(): void {
  if (devFeed) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: 'generic', url: devFeed }); }
  // The coordinator decides when to download; nothing is ever downloaded or installed behind its back.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // A proxy or CDN in between must not answer with an older copy of the release feed.
  autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
  try { autoUpdater.logger = createUpdaterLogger(join(app.getPath('userData'), 'updater.log')); } catch { /* the logger is optional */ }
  // Lookups and downloads report their failures through their promises; an error event is only news while the installer
  // is being started (it can fail after `install()` returned).
  autoUpdater.on('error', (error) => {
    if (coordinator.handoverVersion()) coordinator.failHandover(error);
    else console.error('auto-update error event', error);
  });
}

// ── looking at the feed for the startup gate ─────────────────────────────────────────────────────

/** Whether updates can run at all (installed build, or a development feed). */
export const updatesEnabled = updatesActive;

/** True for portable builds, which never install on their own (macOS reports itself as such only when it cannot replace itself). */
export const isPortableBuild = (): boolean => portable;

/**
 * Looks for an update; the answer becomes the target and the background download starts, so the gate's prompt and its
 * "Install now" find the download already running. Undefined: up to date, or nothing this app can install.
 */
export async function startupCheck(): Promise<{ version: string } | undefined> {
  if (!updatesActive() || portable) return undefined;
  return coordinator.check('startup');
}

/** The last look at the feed before the hand-over: a newer release replaces the target (failures never change the state). */
export async function recheckUpdate(): Promise<{ version: string } | undefined> {
  if (!updatesActive() || portable) return undefined;
  return coordinator.check('recheck');
}

/** Never installs `version` again in this run (it failed before); a finished download of it is ignored. */
export function blockUpdateVersion(version: string | undefined): void { coordinator.block(version); }

/**
 * Downloads the target (or joins the running download), reporting percentages. The gate starts it as soon as the
 * update is offered, so it may keep running as an ordinary background download after the user chose "Later".
 * Rejects with a superseded error when a newer release replaced the target meanwhile.
 */
export async function startupDownload(onProgress: (percent: number) => void): Promise<void> {
  const off = coordinator.addProgressListener(onProgress);
  if (!isMac() && getStrings) void stageSplashRuntime();
  try { await coordinator.download(); }
  finally { off(); }
}

/** Whether an installer has been started in this run (and has not failed to start). */
export const updateHandoffStarted = (): boolean => coordinator.handoverVersion() !== undefined;

/** Shows the progress window; false means installation proceeds without it. */
async function showWindow(version: string): Promise<boolean> {
  if (!getStrings) return false;
  try { return await showUpdateWindow(version, getStrings()); }
  catch (error) { console.error('update window failed', error); return false; }
}

/**
 * Starts the detached installing window and the installer for the downloaded update `version`. `hide` closes the
 * in-app update window once the installing window is visible. False means nothing was handed over (the state already
 * says why). From the moment the lock is taken the version cannot change any more: a newer release is only remembered.
 */
export async function handOver(version: string, hide: () => void): Promise<boolean> {
  if (portable || !coordinator.lockHandover(version)) return false;
  if (isMac()) {
    if (!(await macInstallStaged(version))) return false;
    hide();
    macQuit();
    return true;
  }
  const shown = await showWindow(version);
  hide();
  // install() reports whether the installer started; quitAndInstall would silently do nothing when it did not.
  try {
    const installed = (autoUpdater as unknown as { install(silent: boolean, relaunch: boolean): boolean }).install(true, true);
    if (installed) { app.quit(); return true; }
    failInstall(new Error('Nie udało się zainstalować aktualizacji.'));
  } catch (error) { failInstall(error); }
  if (shown) void abortUpdateWindow();
  return false;
}

/** electron-updater refuses a second install() after one was attempted; a failed attempt must not make every retry fail. */
function failInstall(error: unknown): void {
  coordinator.failHandover(error);
  try { (autoUpdater as unknown as { quitAndInstallCalled?: boolean }).quitAndInstallCalled = false; } catch { /* only a retry is affected */ }
}

// ── macOS flow ─────────────────────────────────────────────────────────────────────────────────

/** Writes and starts the swap script. False means nothing was handed over (the state already says why). */
async function macInstallStaged(version: string): Promise<boolean> {
  const staged = macStaged;
  if (!staged || staged.version !== version) { coordinator.failHandover(new Error(MAC_MESSAGES.verify)); return false; }
  try {
    const result = await macEngine().install(staged);
    if (result.ok) return true;
    // The app turned out not to be replaceable (for example macOS denied App Management): offer the download page.
    coordinator.refuseInstall(staged.version, REFUSAL_MESSAGES[result.refusal]);
  } catch (error) { coordinator.failHandover(error); }
  return false;
}

/** The script waits for this process; the normal quit path winds the terminals down (and exits within its hard limit). */
function macQuit(): void {
  const timer = setTimeout(() => coordinator.failHandover(new Error(MAC_MESSAGES.quitTimeout)), MAC_QUIT_WATCHDOG_MS);
  timer.unref?.();
  app.quit();
}

/** At start: how the previous update ended (only ever not "none" on macOS); a failure is for the caller to remember. */
export async function previousMacUpdate(): Promise<MacPreviousOutcome> {
  if (!isMac() || !updatesActive()) return { kind: 'none' };
  try {
    const outcome = await macEngine().finishPrevious();
    // The existing failure feedback: the status bar shows the error until the next check (the failure itself is recorded by the caller).
    if (outcome.kind === 'failed') coordinator.setStatus({ status: 'error', version: outcome.version, message: MAC_MESSAGES.rolledBack });
    return outcome;
  } catch { return { kind: 'none' }; }
}

/** The main window of this version is up: releases the waiting update script and cleans up (macOS only). */
export function signalMacUpdateReady(): void {
  if (!isMac() || !updatesActive()) return;
  void macEngine().markReady().catch(() => { /* the script gives up waiting on its own */ });
}
