// Small pieces of the Git panel that its components share (labels and classes of the status letters, path pieces, refs).
import type { MessageKey } from './i18n';
import type { GitFileChange, GitRef } from './git';

export const newRequestId = (): string => crypto.randomUUID();

export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;
export const dirName = (path: string): string => {
  const parts = path.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
};

export interface Letter { letter: string; cls: string; title: MessageKey }

/** The letter shown for one side (index or work tree) of a change. */
export function letterOf(code: string): Letter {
  switch (code) {
    case 'A': return { letter: 'A', cls: 'add', title: 'Dodany' };
    case 'D': return { letter: 'D', cls: 'del', title: 'Usunięty' };
    case 'R': return { letter: 'R', cls: 'ren', title: 'Przeniesiony lub przemianowany' };
    case 'C': return { letter: 'C', cls: 'ren', title: 'Skopiowany' };
    case 'T': return { letter: 'T', cls: 'mod', title: 'Zmieniony typ pliku' };
    case '?': return { letter: 'U', cls: 'add', title: 'Nieśledzony' };
    default: return { letter: 'M', cls: 'mod', title: 'Zmodyfikowany' };
  }
}

export const CONFLICT_LETTER: Letter = { letter: '!', cls: 'del', title: 'Konflikt scalania' };

export type ChangeGroup = 'conflict' | 'staged' | 'unstaged' | 'untracked';

/** The rows of the Changes section: a file with both staged and unstaged changes shows up in both groups. */
export function groupChanges(files: readonly GitFileChange[]): Record<ChangeGroup, GitFileChange[]> {
  const groups: Record<ChangeGroup, GitFileChange[]> = { conflict: [], staged: [], unstaged: [], untracked: [] };
  for (const file of files) {
    if (file.conflict) groups.conflict.push(file);
    else if (file.untracked) groups.untracked.push(file);
    else {
      if (file.staged) groups.staged.push(file);
      if (file.unstaged) groups.unstaged.push(file);
    }
  }
  return groups;
}

/** Refs worth a chip next to a commit: the checked out branch first, then other branches, tags, remote branches. */
export function chipRefs(refs: readonly GitRef[], max = 3): { shown: GitRef[]; more: number } {
  const rank = (ref: GitRef): number => (ref.kind === 'head' ? 0 : ref.current ? 1 : ref.kind === 'branch' ? 2 : ref.kind === 'tag' ? 3 : 4);
  const sorted = [...refs].sort((a, b) => rank(a) - rank(b));
  return { shown: sorted.slice(0, max), more: Math.max(0, sorted.length - max) };
}

export const LANE_COLORS = ['#60a5fa', '#4ade80', '#f59e0b', '#c084fc', '#f472b6', '#22d3ee', '#fb923c', '#a3e635'];
