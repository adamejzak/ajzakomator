/**
 * Where the running app lives and whether it may be replaced in place. Free of Electron imports; every file system
 * question is injected so the refusal cases can be exercised on any platform.
 */
import { posix } from 'path';

/** Why the app is not replaced in place; the updater then only offers the download page. */
export type MacRefusal = 'not-bundle' | 'translocated' | 'read-only' | 'not-writable' | 'not-owner' | 'app-management';

export interface TargetFs {
  /** Rejects (with an errno `code`) when the path cannot be written. */
  accessWritable(path: string): Promise<void>;
  /** Owner of the path, undefined when it cannot be read. */
  ownerOf(path: string): Promise<number | undefined>;
  /** uid of the current user (undefined where the platform has no such thing). */
  uid(): number | undefined;
}

const BUNDLE = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/;

/** `/Applications/unimux.app/Contents/MacOS/unimux` -> `/Applications/unimux.app`; undefined outside a .app. */
export function bundlePathFromExecPath(execPath: string): string | undefined {
  return BUNDLE.exec(execPath)?.[1];
}

/** Path of the previous version kept next to the app while an update is applied (not an `.app`, so macOS ignores it). */
export const backupPathFor = (bundle: string, fromVersion: string): string => `${bundle}.old-${fromVersion}`;

export type TargetResult = { ok: true; bundle: string } | { ok: false; reason: MacRefusal; bundle?: string };

const readOnly = (error: unknown): boolean => (error as { code?: string } | undefined)?.code === 'EROFS';

/** Decides whether the bundle can be swapped by a script that runs after the app quit. */
export async function evaluateInstallTarget(execPath: string, packaged: boolean, fs: TargetFs): Promise<TargetResult> {
  const bundle = bundlePathFromExecPath(execPath);
  // A development run executes the Electron binary of node_modules, which must never be replaced.
  if (!packaged || !bundle) return { ok: false, reason: 'not-bundle', bundle };
  if (execPath.includes('/AppTranslocation/') || bundle.includes('/AppTranslocation/')) return { ok: false, reason: 'translocated', bundle };
  for (const path of [posix.dirname(bundle), bundle]) {
    try { await fs.accessWritable(path); }
    catch (error) { return { ok: false, reason: readOnly(error) ? 'read-only' : 'not-writable', bundle }; }
  }
  const uid = fs.uid();
  // Replacing a bundle that belongs to somebody else (an administrator install) needs rights the app does not have.
  if (uid !== undefined && await fs.ownerOf(bundle) !== uid) return { ok: false, reason: 'not-owner', bundle };
  return { ok: true, bundle };
}

/**
 * macOS 13+ may deny writing inside an app bundle without the "App Management" permission. Probed only when the user asked
 * to install (it can show the system prompt), by creating and removing a file at the top of the bundle.
 */
export async function probeBundleWrite(bundle: string, write: (path: string) => Promise<void>, remove: (path: string) => Promise<void>): Promise<boolean> {
  const probe = posix.join(bundle, 'Contents', '.unimux-write-probe');
  try { await write(probe); await remove(probe); return true; }
  catch { await remove(probe).catch(() => {}); return false; }
}

/** Where the verified new bundle waits, next to the installed one (same directory and volume, so the swap is a rename). Not an `.app`. */
export const stagedPathFor = (bundle: string, version: string): string => `${bundle}.new-${version}`;
