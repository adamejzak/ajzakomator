/**
 * One-time move of the data directory from the previous product name to `unimux`. Runs at start-up before anything else
 * touches the data directory (userData, the single-instance lock, the state). Kept free of Electron imports so tests can
 * drive it against temporary directories with failing file operations.
 *
 * Nothing is ever deleted: the old directory is renamed (atomic on one volume, so no partial copies) and a link is left
 * at the old path. Update windows of older versions, the NSIS installer and a downgraded build all keep using the old
 * path and reach the same files through that link.
 */
import { existsSync, lstatSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export const LEGACY_DATA_DIR_NAME = 'ajzakomator';
export const DATA_DIR_NAME = 'unimux';
/** Written into the new directory after a successful rename; tells later starts that the link at the old path is ours to restore. */
export const MIGRATION_MARKER = 'migrated-from.json';

export interface MigrationFs {
  /** Undefined when nothing exists at `path` (a dangling link still counts as existing). */
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean } | undefined;
  exists(path: string): boolean;
  /** The resolved path, undefined when it cannot be resolved (a dangling link). */
  realpath(path: string): string | undefined;
  rename(from: string, to: string): void;
  /** Creates a directory link at `path` pointing to `target`. */
  symlink(target: string, path: string): void;
  writeFile(path: string, data: string): void;
}

export const nodeMigrationFs = (platform: NodeJS.Platform): MigrationFs => ({
  lstat: (path) => { try { return lstatSync(path); } catch { return undefined; } },
  exists: (path) => existsSync(path),
  realpath: (path) => { try { return realpathSync.native(path); } catch { return undefined; } },
  rename: (from, to) => renameSync(from, to),
  // A junction needs no administrator rights or developer mode on Windows; elsewhere a plain directory symlink.
  symlink: (target, path) => symlinkSync(target, path, platform === 'win32' ? 'junction' : 'dir'),
  writeFile: (path, data) => writeFileSync(path, data),
});

export type MigrationAction =
  /** `MC_DATA_DIR` is set: no migration. */
  | 'override'
  /** Nothing to move (fresh install, already migrated, or the old path is a link). */
  | 'current'
  /** Moved and linked. */
  | 'migrated'
  /** Moved, but the link at the old path could not be created (retried on the next start). */
  | 'migrated-without-link'
  /** A run from the repository (not the installed app) found the old directory: it uses it and never moves it. */
  | 'not-packaged'
  /** The old path is a link the user made to another place: it stays the data directory. */
  | 'user-link'
  /** The old directory is in use (an update window still supervises an install): stays where it is for this run. */
  | 'deferred'
  /** A rename failed (locked files): the old directory is used for this run, retried on the next start. */
  | 'rename-failed'
  /** Both directories hold a state: the new one is used, the old one is left alone. */
  | 'both-exist';

export interface MigrationOptions {
  appData: string;
  platform: NodeJS.Platform;
  env: { MC_DATA_DIR?: string };
  /** Only the installed app moves the directory; a run from the repository (`npm run dev`) never does. */
  packaged: boolean;
  fs?: MigrationFs;
  now?: () => number;
  /** True while something still works inside the old directory (the update window of the previous version). */
  busy?: (legacyDir: string) => boolean;
  log?: (message: string) => void;
}

export interface MigrationResult {
  dataDir: string;
  action: MigrationAction;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Decides the data directory for this run and moves the old one when it is safe to. */
export function migrateDataDir(o: MigrationOptions): MigrationResult {
  if (o.env.MC_DATA_DIR) return { dataDir: o.env.MC_DATA_DIR, action: 'override' };
  const fs = o.fs ?? nodeMigrationFs(o.platform);
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const legacy = join(o.appData, LEGACY_DATA_DIR_NAME);
  const current = join(o.appData, DATA_DIR_NAME);
  const link = (): boolean => {
    try { fs.symlink(current, legacy); return true; }
    catch (error) { log(`data directory: the link ${legacy} -> ${current} could not be created (${describe(error)}), retrying on the next start`); return false; }
  };

  const old = fs.lstat(legacy);
  if (!old) {
    // An earlier start moved the directory but could not leave the link behind.
    if (fs.exists(join(current, MIGRATION_MARKER))) link();
    return { dataDir: current, action: 'current' };
  }
  if (old.isSymbolicLink()) {
    // Our own link points to the new directory. A link the user made (data kept on another drive) stays the data directory.
    const target = fs.realpath(legacy);
    const ours = !target || target.toLowerCase() === (fs.realpath(current) ?? current).toLowerCase();
    if (!ours) log(`data directory: ${legacy} links to ${target}, kept as the data directory`);
    return ours ? { dataDir: current, action: 'current' } : { dataDir: legacy, action: 'user-link' };
  }
  if (!old.isDirectory()) return { dataDir: current, action: 'current' };

  if (!o.packaged) return { dataDir: legacy, action: 'not-packaged' };
  if (o.busy?.(legacy)) {
    log(`data directory: ${legacy} is still in use by an update, it is moved on a later start`);
    return { dataDir: legacy, action: 'deferred' };
  }

  if (fs.lstat(current)) {
    const oldHasState = fs.exists(join(legacy, 'state.json'));
    if (fs.exists(join(current, 'state.json')) || !oldHasState) {
      log(`data directory: both ${legacy} and ${current} exist, using ${current} and leaving ${legacy} untouched`);
      return { dataDir: current, action: 'both-exist' };
    }
    // Only an empty shell (created by Electron or the installer marker): keep it aside, never delete it.
    const aside = join(o.appData, `${DATA_DIR_NAME}.pre-migration-${stamp(now())}`);
    try { fs.rename(current, aside); }
    catch (error) {
      log(`data directory: ${current} could not be moved aside (${describe(error)}), using ${legacy} for now`);
      return { dataDir: legacy, action: 'rename-failed' };
    }
    log(`data directory: the previous ${current} (no state) was moved to ${aside}`);
  }

  try { fs.rename(legacy, current); }
  catch (error) {
    // Another instance starting at the same moment moved it first: follow it instead of recreating an empty old directory.
    if (!fs.lstat(legacy) && fs.lstat(current)) return { dataDir: current, action: 'current' };
    log(`data directory: ${legacy} could not be moved to ${current} (${describe(error)}), using it for now`);
    return { dataDir: legacy, action: 'rename-failed' };
  }
  try { fs.writeFile(join(current, MIGRATION_MARKER), JSON.stringify({ from: legacy, at: now() })); }
  catch (error) { log(`data directory: the migration marker could not be written (${describe(error)})`); }
  if (!link()) return { dataDir: current, action: 'migrated-without-link' };
  log(`data directory: moved ${legacy} to ${current}`);
  return { dataDir: current, action: 'migrated' };
}
