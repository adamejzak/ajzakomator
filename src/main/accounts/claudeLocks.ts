// Claude Code's own advisory locks (npm proper-lockfile): a lock is a DIRECTORY created with mkdir; its holder touches the
// mtime every few seconds and a lock older than `stale` belongs to a dead holder. Claude Code refreshes its OAuth token
// holding `<config dir>/.oauth_refresh.lock` and then `<config dir>.lock` (stale 60 s), and writes its global config holding
// `<global config>.lock` (~/.claude.json.lock, stale 10 s). claude-swap takes the same locks for every write to the live
// login, so holding them excludes both. Claude Code's `.oauth_refresh.lock.owner` record is never touched here.
// Hold the locks for local file work only, never across a network request.
import { mkdir, realpath, rmdir, stat, utimes } from 'fs/promises';
import { basename, dirname, join } from 'path';

export const CREDENTIALS_STALE_MS = 60_000;
export const CONFIG_STALE_MS = 10_000;
export const TOUCH_MS = 3_000;
/** Per lock; Claude Code holds its credential lock for one token round trip. */
export const LOCK_TIMEOUT_MS = 9_000;

export interface LockDeps {
  timeoutMs?: number; touchMs?: number; now?(): number; sleep?(ms: number): Promise<void>;
  /** Removes a lock directory (tests replace it to simulate a busy one). */
  rmdir?(path: string): Promise<void>;
}

/** Tries of the release: on Windows an antivirus or indexer may hold the empty lock dir for a moment (EPERM, EBUSY). */
export const RELEASE_TRIES = 5;
const RELEASE_GAP_MS = 100;

export class LockTimeout extends Error {
  constructor(readonly lock: string) { super(`lock held: ${lock}`); this.name = 'LockTimeout'; }
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** Takes one directory lock (never creating its parent); resolves to the release function. */
export async function acquireDirLock(path: string, staleMs: number, deps: LockDeps = {}): Promise<() => Promise<void>> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeout = deps.timeoutMs ?? LOCK_TIMEOUT_MS;
  const remove = deps.rmdir ?? ((dir: string) => rmdir(dir));
  const start = now();
  for (;;) {
    try { await mkdir(path); break; } catch (error) { if (code(error) !== 'EEXIST') throw error; }
    if (now() - start > timeout) throw new LockTimeout(basename(path));
    let mtime: number;
    try { mtime = (await stat(path)).mtimeMs; } catch (error) { if (code(error) === 'ENOENT') continue; throw error; }
    if (Date.now() - mtime > staleMs) {
      // A dead holder (the protocol's rule): remove and retake; losing the race to another waiter just loops again.
      await remove(path).catch(() => sleep(50));
      continue;
    }
    await sleep(250 + Math.floor(Math.random() * 250));
  }
  const timer = setInterval(() => { const t = new Date(); void utimes(path, t, t).catch(() => undefined); }, deps.touchMs ?? TOUCH_MS);
  timer.unref?.();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    // A lock left behind would make Claude Code wait for it to go stale (60 s) before it can renew its login.
    for (let attempt = 1; ; attempt++) {
      try { await remove(path); return; } catch (error) {
        const reason = code(error);
        if (reason === 'ENOENT') return;
        if ((reason !== 'EPERM' && reason !== 'EBUSY') || attempt >= RELEASE_TRIES) throw error;
      }
      await sleep(RELEASE_GAP_MS);
    }
  };
}

export interface ClaudeLockPaths { primary: string; legacy: string; config: string }

/** `credentials` is `<config dir>/.credentials.json`, `claudeJson` the global config (`~/.claude.json` or `<CLAUDE_CONFIG_DIR>/.claude.json`). */
export async function claudeLockPaths(paths: { credentials: string; claudeJson: string }): Promise<ClaudeLockPaths> {
  const configDir = dirname(paths.credentials);
  // Claude Code appends ".lock" to the resolved config dir (symlinks followed).
  const real = await realpath(configDir).catch(() => configDir);
  return { primary: join(configDir, '.oauth_refresh.lock'), legacy: `${real}.lock`, config: `${paths.claudeJson}.lock` };
}

/** Runs `fn` holding the credential locks (primary, then legacy) and, unless `credentialsOnly`, the config lock; always released. */
export async function withClaudeLocks<T>(paths: { credentials: string; claudeJson: string }, fn: () => Promise<T>, deps: LockDeps & { credentialsOnly?: boolean } = {}): Promise<T> {
  const lockPaths = await claudeLockPaths(paths);
  const releases: Array<() => Promise<void>> = [];
  try {
    releases.push(await acquireDirLock(lockPaths.primary, CREDENTIALS_STALE_MS, deps));
    releases.push(await acquireDirLock(lockPaths.legacy, CREDENTIALS_STALE_MS, deps));
    if (!deps.credentialsOnly) releases.push(await acquireDirLock(lockPaths.config, CONFIG_STALE_MS, deps));
    return await fn();
  } finally {
    for (const release of releases.reverse()) await release().catch(() => undefined);
  }
}
