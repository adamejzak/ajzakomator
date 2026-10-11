import { app } from 'electron';
import { existsSync } from 'fs';
import { rm, writeFile, mkdir } from 'fs/promises';
import { basename, dirname, join } from 'path';
import type { UpdateSplashConfig, UpdateStrings } from '../shared/updateProgress';
import { installInProgress, readUpdateAttempt, stageRuntime, startSplash, waitForFile } from './updateRuntime';

const SHOWN_WAIT_MS = 4000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const CLEANUP_DELAY_MS = 30 * 1000;
/** A normal install takes well under this; after it a vanished update window must not lock the app out. */
export const START_BLOCK_MS = 90 * 1000;

const updateDir = () => join(app.getPath('userData'), 'update');
const runtimeDir = () => join(updateDir(), 'runtime');
/** The NSIS installer writes `installer-done` at this fixed location (see resources/installer.nsh). */
const installedFlag = () => join(updateDir(), 'installer-done');
const readyFlag = () => join(updateDir(), 'ready');
const shownFlag = () => join(updateDir(), 'work', 'shown');
const abortFlag = () => join(updateDir(), 'work', 'abort');
const heartbeatFlag = () => join(updateDir(), 'work', 'heartbeat');

let staging: Promise<string | undefined> | undefined;

/** The update window only exists for the installed Windows build; elsewhere installation stays as before. */
const supported = () => process.platform === 'win32' && app.isPackaged;

/** Whether an installer started by the update window may still be running (see `installInProgress`). */
export const updateInstalling = (maxAgeMs: number): boolean => installInProgress(updateDir(), app.getVersion(), maxAgeMs);

/** Prepares the private runtime in the background so clicking "install" can show the window instantly. */
export function stageSplashRuntime(): Promise<string | undefined> {
  if (!supported()) return Promise.resolve(undefined);
  staging ??= stageRuntime({
    installDir: dirname(process.execPath),
    exeName: basename(process.execPath),
    appDir: app.getAppPath(),
    runtimeDir: runtimeDir(),
    fingerprint: process.versions.electron,
  }).catch((error) => {
    console.error('update window staging failed', error);
    return undefined;
  }).then((exe) => { if (!exe) staging = undefined; return exe; });
  return staging;
}

/**
 * Starts the detached update window and waits briefly until it is visible. Resolves false when the
 * window is unavailable, in which case the caller installs exactly as it did before.
 */
export async function showUpdateWindow(version: string, mode: 'relaunch' | 'quit', strings: UpdateStrings): Promise<boolean> {
  const exe = await stageSplashRuntime();
  if (!exe) return false;
  const config: UpdateSplashConfig = {
    mode, version, fromVersion: app.getVersion(), oldPid: process.pid,
    installDir: dirname(process.execPath), appExe: process.execPath,
    installedFlag: installedFlag(), readyFlag: readyFlag(), shownFlag: shownFlag(), abortFlag: abortFlag(), heartbeatFlag: heartbeatFlag(),
    runtimeDir: runtimeDir(), workDir: join(updateDir(), 'work'),
    timeoutMs: INSTALL_TIMEOUT_MS, strings,
  };
  const started = await startSplash(exe, config, [installedFlag(), readyFlag(), shownFlag(), abortFlag(), heartbeatFlag()]);
  if (!started) return false;
  await waitForFile(shownFlag(), SHOWN_WAIT_MS);
  return true;
}

/** Closes the update window when the hand-off to the installer failed and the app keeps running. */
export async function abortUpdateWindow(): Promise<void> {
  try { await writeFile(abortFlag(), String(Date.now())); } catch { /* the window times out on its own */ }
}

/** Called by the new version once its window is up, which completes the update window's last step. */
export async function signalUpdateReady(): Promise<void> {
  // An old build started while the installer is still running must not report the update as finished.
  if (readUpdateAttempt(updateDir())?.version !== app.getVersion()) return;
  try {
    await mkdir(updateDir(), { recursive: true });
    await writeFile(readyFlag(), app.getVersion());
  } catch { /* the update window times out gracefully */ }
}

/** Removes the private runtime and signals left by a finished update (the window needs a moment to exit). */
export function scheduleUpdateCleanup(): void {
  if (!existsSync(updateDir())) return;
  const timer = setTimeout(() => {
    if (staging || updateInstalling(INSTALL_TIMEOUT_MS)) return;
    void rm(updateDir(), { recursive: true, force: true }).catch(() => { /* retried on next start */ });
  }, CLEANUP_DELAY_MS);
  timer.unref?.();
}
