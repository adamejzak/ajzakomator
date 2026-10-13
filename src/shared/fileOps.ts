// Pure helpers and shared types for file operations in the project tree (rename, move, copy, delete).
// Paths are project-relative with forward slashes; '' is the project root.
import type { AppPlatform } from './platform';

export type ConflictPolicy = 'ask' | 'replace' | 'keepBoth' | 'skip';

export interface FileMoveRecord { from: string; to: string }
export interface FileOpFailure { path: string; error: string }

export interface FileOpRequest {
  kind: 'move' | 'copy';
  paths: string[];
  /** Destination folder (project-relative, '' = project root). */
  destination: string;
  conflict: ConflictPolicy;
  /** Skip the large-copy confirmation (the user already confirmed it). */
  force?: boolean;
  /** Lets the renderer cancel a running copy and match progress events. */
  opId?: string;
}

export interface FileConflict { path: string; name: string; directory: boolean }

export type FileOpResult =
  | { ok: true; done: FileMoveRecord[]; skipped: string[]; failed: FileOpFailure[]; notes: string[]; cancelled: boolean }
  | { ok: false; code: 'conflict'; error: string; conflicts: FileConflict[] }
  | { ok: false; code: 'large'; error: string; entries: number; bytes: number }
  | { ok: false; code?: 'failed'; error: string };

export type RenameResult = { ok: true; from: string; to: string } | { ok: false; error: string };
export type DeleteResult = { ok: true; trashed: string[]; failed: FileOpFailure[] } | { ok: false; error: string };
export type CreateResult = { ok: true; path: string } | { ok: false; error: string };
export interface FileOpProgress { opId: string; entries: number; bytes: number }

/** Above this a copy asks for confirmation first. */
export const LARGE_COPY_BYTES = 500 * 1024 * 1024;
export const LARGE_COPY_ENTRIES = 20000;

export const toPosix = (path: string): string => path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const parentPath = (path: string): string => { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); };
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
export const hasGitSegment = (path: string): boolean => path.split('/').includes('.git');
/** The id convention of open editor tabs. */
export const documentId = (projectId: string, path: string): string => JSON.stringify([projectId, path]);

/** True when `path` equals `ancestor` or lies inside it ('' is the project root and contains everything). */
export function isSameOrDescendant(ancestor: string, path: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Where `path` ends up when `from` is moved to `to`; null when `path` is not affected. */
export function retargetPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return from && path.startsWith(`${from}/`) ? joinPath(to, path.slice(from.length + 1)) : null;
}

/** Applies several simultaneous moves to one path (the most specific matching move wins). */
export function retargetByMoves(path: string, moves: FileMoveRecord[]): string {
  let best: FileMoveRecord | null = null;
  for (const move of moves) if (isSameOrDescendant(move.from, path) && (!best || move.from.length > best.from.length)) best = move;
  return best ? retargetPath(path, best.from, best.to) ?? path : path;
}

/** Drops entries that live inside another listed entry (moving a folder already moves its content). */
export function topLevelPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((path) => !unique.some((other) => other !== path && isSameOrDescendant(other, path)));
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** A Polish message (the translation key) when the name cannot be used for a file or folder, otherwise null. */
export function validateEntryName(name: string, platform: AppPlatform = 'linux'): string | null {
  if (!name || !name.trim()) return 'Nazwa nie może być pusta.';
  if (name === '.' || name === '..') return 'Ta nazwa jest zarezerwowana.';
  if (name.length > 255) return 'Nazwa jest zbyt długa.';
  if (/[\/\0]/.test(name)) return 'Nazwa zawiera niedozwolone znaki.';
  if (platform === 'win32') {
    if (/[\\<>:"|?*\x00-\x1f]/.test(name)) return 'Nazwa zawiera niedozwolone znaki.';
    if (/[. ]$/.test(name)) return 'Nazwa nie może kończyć się kropką ani spacją.';
    if (WINDOWS_RESERVED.test(name)) return 'Ta nazwa jest zarezerwowana.';
  }
  return null;
}

/** "name.txt" -> "name copy.txt" (n = 1), "name copy 2.txt" (n = 2) ... Folders and dotfiles keep their whole name as the stem. */
export function copyName(name: string, n: number, directory: boolean): string {
  const dot = directory ? -1 : name.lastIndexOf('.');
  const hasExt = dot > 0;
  const stem = (hasExt ? name.slice(0, dot) : name).replace(/ copy(?: \d+)?$/, '');
  const ext = hasExt ? name.slice(dot) : '';
  return `${stem} copy${n > 1 ? ` ${n}` : ''}${ext}`;
}

/** The part of the name worth pre-selecting for rename (without the extension). */
export function renameSelectionEnd(name: string, directory: boolean): number {
  const dot = name.lastIndexOf('.');
  return directory || dot <= 0 ? name.length : dot;
}

export interface DocumentLike { id: string; projectId: string; relativePath: string; name: string }

/**
 * Open editor tabs follow renamed or moved files and folders: path, name and id change, everything else
 * (text, dirty state) stays. A moved tab replaces an unrelated tab that was open on the overwritten target.
 */
export function retargetDocuments<T extends DocumentLike>(
  documents: T[], activeId: string | null, projectId: string, moves: FileMoveRecord[],
): { documents: T[]; activeId: string | null; changed: boolean } {
  if (!moves.length) return { documents, activeId, changed: false };
  const idMap = new Map<string, string>();
  const moved = new Set<T>();
  const mapped = documents.map((doc) => {
    if (doc.projectId !== projectId) return doc;
    const path = retargetByMoves(doc.relativePath, moves);
    if (path === doc.relativePath) return doc;
    const id = documentId(projectId, path);
    idMap.set(doc.id, id);
    const next = { ...doc, id, relativePath: path, name: baseName(path) };
    moved.add(next);
    return next;
  });
  if (!idMap.size) return { documents, activeId, changed: false };
  const seen = new Set<string>();
  const result: T[] = [];
  // Moved tabs win over stale tabs with the same id.
  for (const doc of mapped) {
    if (!moved.has(doc) && mapped.some((other) => other !== doc && other.id === doc.id && moved.has(other))) continue;
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    result.push(doc);
  }
  let nextActive = activeId ? idMap.get(activeId) ?? activeId : null;
  if (nextActive && !result.some((doc) => doc.id === nextActive)) nextActive = result.filter((doc) => doc.projectId === projectId).at(-1)?.id ?? null;
  return { documents: result, activeId: nextActive, changed: true };
}

/** Ids of the open tabs that belong to deleted (trashed) paths. */
export function documentsUnder<T extends DocumentLike>(documents: T[], projectId: string, paths: string[]): string[] {
  return documents.filter((doc) => doc.projectId === projectId && paths.some((path) => isSameOrDescendant(path, doc.relativePath))).map((doc) => doc.id);
}

/** Removes tabs; when the active one disappears the last remaining tab of the project becomes active. */
export function removeDocuments<T extends DocumentLike>(documents: T[], activeId: string | null, ids: Iterable<string>): { documents: T[]; activeId: string | null } {
  const gone = new Set(ids);
  if (!gone.size) return { documents, activeId };
  const rest = documents.filter((doc) => !gone.has(doc.id));
  if (!activeId || !gone.has(activeId)) return { documents: rest, activeId };
  const project = documents.find((doc) => doc.id === activeId)?.projectId;
  return { documents: rest, activeId: rest.filter((doc) => doc.projectId === project).at(-1)?.id ?? null };
}

/** Applies moves to a set of paths (expanded folders, selection, clipboard). */
export function retargetPathSet(paths: Iterable<string>, moves: FileMoveRecord[]): string[] {
  return [...paths].map((path) => retargetByMoves(path, moves));
}

/** Tabs to close for "Close others / to the right / all", in strip order. */
export function tabsToClose(order: string[], anchor: string, mode: 'others' | 'right' | 'all'): string[] {
  const index = order.indexOf(anchor);
  if (mode === 'all') return [...order];
  if (index < 0) return [];
  return mode === 'others' ? order.filter((id) => id !== anchor) : order.slice(index + 1);
}

/** Short list of names for a confirmation text: the first few, then "and N more". */
export function summarizeNames(names: string[], limit = 5): { shown: string[]; more: number } {
  return { shown: names.slice(0, limit), more: Math.max(0, names.length - limit) };
}
