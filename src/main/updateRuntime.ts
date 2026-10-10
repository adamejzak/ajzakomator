/**
 * Builds and starts the detached update window. Kept free of Electron imports so it can be exercised
 * against any Electron distribution (the packaged app, or `node_modules/electron/dist` in tests).
 */
import { spawn } from 'child_process';
import { cp, copyFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
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

/** The splash app itself is tiny, so it is refreshed on every staging. */
async function writeSplashApp(appDir: string, splashApp: string): Promise<void> {
  await rm(splashApp, { recursive: true, force: true });
  await mkdir(splashApp, { recursive: true });
  await writeFile(join(splashApp, 'package.json'), JSON.stringify({ name: 'ajzakomator-update', version: '1.0.0', main: 'main/updatesplash.js' }));
  await cp(join(appDir, 'out', 'main'), join(splashApp, 'main'), { recursive: true });
  await cp(join(appDir, 'out', 'preload'), join(splashApp, 'preload'), { recursive: true });
  await cp(join(appDir, 'resources', 'update-splash'), join(splashApp, 'ui'), { recursive: true });
  await copyFile(join(appDir, 'resources', 'icon.png'), join(splashApp, 'ui', 'icon.png'));
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

/** Resolves true as soon as `file` exists, false after `timeoutMs`. */
export async function waitForFile(file: string, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}
