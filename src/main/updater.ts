import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/types';
import type { UpdateStrings } from '../shared/updateProgress';
import { abortUpdateWindow, showUpdateWindow, stageSplashRuntime } from './updateSplash';

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
  if (!app.isPackaged) {
    set({ status: 'error', message: 'Aktualizacje są dostępne w zainstalowanej aplikacji.' });
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

/** `strings` localizes the detached update window; without it installation stays invisible as before. */
export function initUpdater(onChange: (s: UpdateState) => void, strings?: () => UpdateStrings): void {
  emit = onChange;
  getStrings = strings;
  if (initialized) { emit(state); return; }
  initialized = true;
  portable = !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) || process.platform === 'darwin';
  state = { ...state, portable };
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = !portable;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ status: 'current' }));
  autoUpdater.on('update-available', (info) => set(portable
    ? { status: 'available', version: info.version, url: RELEASES_URL }
    : { status: 'downloading', version: info.version, percent: 0 }));
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
async function showWindow(mode: 'relaunch' | 'quit'): Promise<boolean> {
  if (!getStrings || !state.version) return false;
  try { return await showUpdateWindow(state.version, mode, getStrings()); }
  catch (error) { console.error('update window failed', error); return false; }
}

export function installNow(): void {
  if (portable || state.status !== 'ready') return;
  set({ ...state, status: 'installing' });
  void (async () => {
    const shown = await showWindow('relaunch');
    // Without the window, keep the short pause that lets the renderer paint the installing state.
    if (!shown) await new Promise((resolve) => setTimeout(resolve, 400));
    try { autoUpdater.quitAndInstall(true, true); }
    catch (error) { fail(error); if (shown) void abortUpdateWindow(); }
  })();
}

export async function installOnQuit(): Promise<void> {
  if (portable || state.status !== 'ready') return;
  const shown = await showWindow('quit');
  try {
    const installed = (autoUpdater as unknown as { install(silent: boolean, relaunch: boolean): boolean }).install(true, false);
    if (!installed) { fail(new Error('Nie udało się zainstalować aktualizacji.')); if (shown) void abortUpdateWindow(); }
  } catch (error) { fail(error); if (shown) void abortUpdateWindow(); }
}
