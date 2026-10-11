/**
 * Builds and starts the detached update window. Kept free of Electron imports so it can be exercised
 * against any Electron distribution (the packaged app, or `node_modules/electron/dist` in tests).
 */
import { spawn } from 'child_process';
import { cp, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import type { UpdateSplashConfig } from '../shared/updateProgress';

export const SPLASH_EXE = 'ajzakomator-update.exe';
const STAGED_MARKER = '.staged';
/** GPU compiler libraries and licence pages are never needed by a small software-rendered window. */
const SKIPPED_FILES = new Set(['dxcompiler.dll', 'dxil.dll', 'licenses.chromium.html', 'elevate.exe']);

export interface StageOptions {
  /** Directory of the installed (or any) Electron distribution to clone. */
  installDir: string;
  /** Name of the Electron executable inside `installDir`. */
  exeName: string;
  /** Application root holding `out/` and `resources/update-splash/`. */
  appDir: string;
  /** Destination for the private runtime. */
  runtimeDir: string;
  /** Marker value; a matching marker means the heavy copy can be reused. */
  fingerprint: string;
}

/** Whether `path` (relative to the Electron distribution) belongs in the private runtime. */
export function shouldCopy(installDir: string, path: string, exeName: string): boolean {
  const parts = relative(installDir, path).split(sep).map((part) => part.toLowerCase());
  if (parts[0] === '') return true;
  const name = parts[parts.length - 1];
  if (parts.length === 1) return name !== exeName.toLowerCase() && !SKIPPED_FILES.has(name) && !name.startsWith('uninstall');
  if (parts[0] === 'resources') return false;
  if (parts[0] === 'locales' && parts.length === 2) return name === 'en-us.pak';
  return !SKIPPED_FILES.has(name);
}

/** Copies the Electron runtime plus the update window into `runtimeDir` and returns its executable. */
export async function stageRuntime(options: StageOptions): Promise<string> {
  const { installDir, exeName, appDir, runtimeDir, fingerprint } = options;
  const target = join(runtimeDir, SPLASH_EXE);
  const marker = join(runtimeDir, STAGED_MARKER);
  const reusable = existsSync(target) && await readFile(marker, 'utf8').then((value) => value === fingerprint, () => false);
  if (!reusable) {
    const partial = `${runtimeDir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    await cp(installDir, partial, { recursive: true, filter: (source) => shouldCopy(installDir, source, exeName) });
    await copyFile(join(installDir, exeName), join(partial, SPLASH_EXE));
    await writeFile(join(partial, STAGED_MARKER), fingerprint);
    await rename(partial, runtimeDir);
  }
  await writeSplashApp(appDir, join(runtimeDir, 'resources', 'app'));
  return target;
}

/**
 * Plain recursive copy. `appDir` may be an asar archive, where `fs.cp` is not reliable but readdir/stat/readFile
 * (patched by Electron) are.
 */
async function copyTree(source: string, target: string): Promise<void> {
  if ((await stat(source)).isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) await copyTree(join(source, name), join(target, name));
  } else {
    await writeFile(target, await readFile(source));
  }
}

/** The splash app itself is tiny, so it is refreshed on every staging. */
async function writeSplashApp(appDir: string, splashApp: string): Promise<void> {
  await rm(splashApp, { recursive: true, force: true });
  await mkdir(splashApp, { recursive: true });
  await writeFile(join(splashApp, 'package.json'), JSON.stringify({ name: 'ajzakomator-update', version: '1.0.0', main: 'main/updatesplash.js' }));
  await copyTree(join(appDir, 'out', 'main'), join(splashApp, 'main'));
  await copyTree(join(appDir, 'out', 'preload'), join(splashApp, 'preload'));
  await copyTree(join(appDir, 'resources', 'update-splash'), join(splashApp, 'ui'));
  await copyTree(join(appDir, 'resources', 'icon.png'), join(splashApp, 'ui', 'icon.png'));
}

/** Removes signals from earlier attempts, writes the config and starts the window; false if it could not start. */
export async function startSplash(exe: string, config: UpdateSplashConfig, stale: string[]): Promise<boolean> {
  try {
    await mkdir(config.workDir, { recursive: true });
    await Promise.all(stale.map((file) => rm(file, { force: true })));
    const configPath = join(config.workDir, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    return await new Promise<boolean>((resolve) => {
      const child = spawn(exe, [`--update-config=${configPath}`], { detached: true, stdio: 'ignore', cwd: dirname(exe) });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
  } catch {
    return false;
  }
}

/** Version the last update window was started for, and when; undefined if there was none. */
export function readUpdateAttempt(updateDir: string): { version: string; startedAt: number } | undefined {
  try {
    const file = join(updateDir, 'work', 'config.json');
    const { version } = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof version === 'string' ? { version, startedAt: statSync(file).mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True while an installer started by an update window is (probably) still replacing the app files:
 * the attempt targets another version, is younger than `maxAgeMs` and has not signalled completion or abort.
 * Starting the old build or deleting the update directory in that window breaks the installation.
 */
export function installInProgress(updateDir: string, currentVersion: string, maxAgeMs: number, now = Date.now()): boolean {
  const attempt = readUpdateAttempt(updateDir);
  if (!attempt || attempt.version === currentVersion) return false;
  const finished = ['installer-done', 'ready'].some((name) => existsSync(join(updateDir, name)))
    || existsSync(join(updateDir, 'work', 'abort'));
  if (finished) return false;
  const age = now - attempt.startedAt;
  if (age <= maxAgeMs) return true;
  // A slow installer (antivirus, slow disk, a late administrator prompt) outlives the usual window; the update window's
  // heartbeat proves it is still supervising, so starting the half-replaced app is still wrong.
  return age <= HEARTBEAT_MAX_AGE_MS && heartbeatFresh(join(updateDir, 'work', 'heartbeat'), now);
}

/** Past this age even a beating update window is no longer trusted. */
export const HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;
const HEARTBEAT_FRESH_MS = 15 * 1000;

function heartbeatFresh(file: string, now: number): boolean {
  try { const age = now - statSync(file).mtimeMs; return age >= -HEARTBEAT_FRESH_MS && age <= HEARTBEAT_FRESH_MS; }
  catch { return false; }
}

/** Resolves true as soon as `file` exists, false after `timeoutMs`. */
export async function waitForFile(file: string, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}
