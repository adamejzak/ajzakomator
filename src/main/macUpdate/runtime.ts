/** Binds the macOS updater to Electron, the real file system and real processes. Only ever called on darwin. */
import { execFile, spawn } from 'child_process';
import { app, net } from 'electron';
import * as fsp from 'fs/promises';
import { posix } from 'path';
import { MAC_FEED_URL, macAssetBase, MacUpdater, type ExecResult } from './engine';

/** The environment of the update script: it must not depend on whatever the app was started with. */
const SCRIPT_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '', LANG: 'en_US.UTF-8' };

function exec(command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: SCRIPT_ENV }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), missing: (error as { code?: unknown } | null)?.code === 'ENOENT' });
    });
  });
}

function spawnDetached(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', env: SCRIPT_ENV, cwd: '/' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

/**
 * `devFeed` (an unpackaged build only) replaces the GitHub release feed with a plain directory served over HTTP that holds
 * `latest-mac.yml` and the archives; the build still refuses to replace itself because it is not a packaged bundle.
 */
export function createMacUpdater(devFeed: string | undefined, log: (line: string) => void): MacUpdater {
  const base = devFeed ? `${devFeed.replace(/\/+$/, '')}/` : undefined;
  return new MacUpdater({
    arch: process.arch,
    currentVersion: app.getVersion(),
    execPath: process.execPath,
    pid: process.pid,
    packaged: app.isPackaged,
    updateDir: posix.join(app.getPath('userData'), 'updates', 'mac'),
    feedUrl: base ? `${base}latest-mac.yml` : MAC_FEED_URL,
    assetBase: (version) => base ?? macAssetBase(version),
    // net.fetch follows the system proxy settings, like the rest of Chromium.
    fetch: (url, init) => net.fetch(url, init as never) as unknown as Promise<Response>,
    fs: fsp,
    exec,
    spawnDetached,
    uid: () => process.getuid?.(),
    now: () => Date.now(),
    log,
  });
}
