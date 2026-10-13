// ONE way to compare folders in the Git module. A folder has many spellings: Windows 8.3 short names (`RUNNER~1`), another drive letter
// case, back or forward slashes, a junction or a subst drive; git reports its own spelling (long names, forward slashes, resolved links).
// Every path that is compared (project folder, repository root, worktrees, cell folders, lock and trust keys) goes through `canonicalPath`
// first. This is only for comparing roots: the confinement of file paths inside a repository (no links, no aliases) lives in git.ts.
import { realpathSync } from 'fs';
import { dirname, resolve } from 'path';

export interface PathOps {
  /** Resolves links and short names (fs.realpathSync.native); throws when the path does not exist. */
  realpath(path: string): string;
  platform: NodeJS.Platform;
}

export const defaultPathOps: PathOps = { realpath: (path) => realpathSync.native(path), platform: process.platform };

const BACKSLASH = /\\/g;
const VERBATIM_PREFIX = /^\/\/[?.]\//;
const REPEATED_SLASH = /(?<!^)\/{2,}/g;
const TRAILING_SLASHES = /\/+$/;
const DRIVE_ROOT = /^[A-Za-z]:\/$/;
const TRAILING_ANY = /[\\/]+$/;
const EDGE_SEPARATORS = /^[\\/]+|[\\/]+$/g;

const slashes = (path: string): string => {
  let value = path.replace(BACKSLASH, '/').replace(VERBATIM_PREFIX, '').replace(REPEATED_SLASH, '/');
  if (value.length > 1 && !DRIVE_ROOT.test(value)) value = value.replace(TRAILING_SLASHES, '');
  return value;
};
const fold = (path: string, platform: NodeJS.Platform): string => (platform === 'win32' ? path.toLowerCase() : path);

/** The text form of a path that can be compared: forward slashes, no trailing slash, no verbatim prefix, folded case on Windows. */
export function normalizeSpelling(path: string, platform: NodeJS.Platform = process.platform): string {
  return fold(slashes(path), platform);
}

/** The real spelling of a folder (links and 8.3 names resolved, forward slashes, case kept); a missing folder resolves through its nearest existing parent. */
function realSpelling(path: string, ops: PathOps): string {
  const absolute = ops.platform === 'win32' || path.startsWith('/') ? path : resolve(path);
  const rest: string[] = [];
  let current = absolute;
  for (let guard = 0; guard < 64; guard++) {
    try {
      const real = ops.realpath(current);
      return slashes(rest.length ? `${real.replace(TRAILING_ANY, '')}/${rest.reverse().join('/')}` : real);
    } catch {
      const parent = dirname(current);
      if (parent === current || parent === '.') break;
      rest.push(current.slice(parent.length).replace(EDGE_SEPARATORS, ''));
      current = parent;
    }
  }
  return slashes(absolute);
}

/**
 * The canonical spelling of a folder for comparing: its real path (links and 8.3 names resolved), forward slashes, case folded on
 * Windows. When nothing resolves, the lexical path is used.
 */
export function canonicalPath(path: string, ops: PathOps = defaultPathOps): string {
  return fold(realSpelling(path, ops), ops.platform);
}

export const samePath = (a: string, b: string, ops: PathOps = defaultPathOps): boolean => canonicalPath(a, ops) === canonicalPath(b, ops);

/** Is `child` the folder `parent` or inside it? */
export function isInsidePath(parent: string, child: string, ops: PathOps = defaultPathOps): boolean {
  const p = canonicalPath(parent, ops);
  const c = canonicalPath(child, ops);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** The path of `child` below `parent` (forward slashes, real case, '' when equal), or null when it is not inside. */
export function relativeInside(parent: string, child: string, ops: PathOps = defaultPathOps): string | null {
  const p = canonicalPath(parent, ops);
  const c = canonicalPath(child, ops);
  if (c === p) return '';
  const prefix = p.endsWith('/') ? p : `${p}/`;
  return c.startsWith(prefix) ? realSpelling(child, ops).slice(prefix.length) : null;
}
