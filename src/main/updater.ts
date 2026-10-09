// Auto-update from the public releases repo (GitHub Releases, see package.json build.publish).
// Installed (NSIS) builds download in the background and offer "restart to update";
// the portable build can't replace itself, so it only links to the download page.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateState } from '../shared/types';

export const RELEASES_URL = 'https://github.com/adamejzak/ajzakomator/releases/latest';
const CHECK_EVERY_MS = 30 * 60 * 1000;

let state: UpdateState = { status: 'idle' };

export function getUpdateState(): UpdateState {
  return state;
}

export function initUpdater(onChange: (s: UpdateState) => void): void {
  if (!app.isPackaged) return;
  // macOS builds have no publisher certificate; automatic installation needs a trusted identity.
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR || process.platform === 'darwin';
  const set = (patch: UpdateState) => {
    state = { ...patch, portable };
    onChange(state);
  };

  autoUpdater.autoDownload = !portable;
  autoUpdater.autoInstallOnAppQuit = false; // we install from our own shutdown path (see installOnQuit)
  autoUpdater.on('update-available', (info) =>
    set(portable ? { status: 'available', version: info.version, url: RELEASES_URL } : { status: 'downloading', version: info.version, percent: 0 }),
  );
  autoUpdater.on('download-progress', (p) => {
    if (state.status === 'downloading') set({ ...state, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    console.error('auto-update failed', err);
    if (state.status === 'downloading') set({ status: 'idle' });
  });

  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 8000);
  setInterval(check, CHECK_EVERY_MS);
}

/** User clicked "restart to update". */
export function installNow(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall(true, true);
}

/** On a normal quit, apply an already downloaded update silently (without relaunching). */
export function installOnQuit(): void {
  if (state.status !== 'ready') return;
  try {
    // `install` lives on the platform updater (NsisUpdater), not on the AppUpdater base type.
    (autoUpdater as unknown as { install(isSilent: boolean, isForceRunAfter: boolean): boolean }).install(true, false);
  } catch (err) {
    console.error('install on quit failed', err);
  }
}
