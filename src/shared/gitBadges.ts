// Git marks for the Files tree (U, M, A, D ... at the right of a row): worked out from one status, by project-relative path.
import type { GitFileChange, GitProjectRelation } from './git';
import { projectRelativePath } from './git';
import { CONFLICT_LETTER, letterOf, type Letter } from './gitUi';

export interface Badges {
  /** Project-relative file path -> its letter. */
  files: Record<string, Letter>;
  /** Project-relative folder path -> the class of the most important change inside (a dot next to the folder). */
  dirs: Record<string, string>;
  /** Untracked folders (git lists them as one entry): everything below them is untracked too. */
  untrackedDirs: string[];
}

const PRIORITY: Record<string, number> = { del: 4, mod: 3, ren: 2, add: 1 };

export const EMPTY_BADGES: Badges = { files: {}, dirs: {}, untrackedDirs: [] };

export function buildBadges(changes: readonly GitFileChange[], relation: GitProjectRelation | null, windows = false): Badges {
  const badges: Badges = { files: {}, dirs: {}, untrackedDirs: [] };
  const mark = (path: string, cls: string): void => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if ((PRIORITY[cls] ?? 0) > (PRIORITY[badges.dirs[dir]] ?? 0)) badges.dirs[dir] = cls;
    }
  };
  for (const change of changes) {
    const relative = projectRelativePath(relation, change.path, windows);
    if (!relative) continue;
    const letter: Letter = change.conflict ? CONFLICT_LETTER
      : change.untracked ? letterOf('?')
      : letterOf(change.y !== ' ' && change.y !== '.' ? change.y : change.x);
    if (change.path.endsWith('/')) { badges.untrackedDirs.push(relative); mark(`${relative}/x`, letter.cls); continue; }
    badges.files[relative] = letter;
    mark(relative, letter.cls);
  }
  return badges;
}

/** The mark of one tree row: its own letter, or (for a folder) the dot of what changed inside. */
export function badgeFor(badges: Badges, path: string, folder: boolean): { letter: Letter | null; dot: string | null } {
  if (folder) {
    if (badges.untrackedDirs.includes(path)) return { letter: letterOf('?'), dot: null };
    if (badges.untrackedDirs.some((dir) => path.startsWith(`${dir}/`))) return { letter: null, dot: 'add' };
    return { letter: null, dot: badges.dirs[path] ?? null };
  }
  const own = badges.files[path];
  if (own) return { letter: own, dot: null };
  return badges.untrackedDirs.some((dir) => path.startsWith(`${dir}/`)) ? { letter: letterOf('?'), dot: null } : { letter: null, dot: null };
}
