// Dragging files and folders from the Files tree onto a cell: the payload, its validation and the text that ends up in the
// cell's input. Everything here is pure; the DOM event data is untrusted and never reaches a terminal unchecked.
import { fullProjectPath, type AppPlatform } from './platform';
import type { CellStatus } from './status';
import type { CliKind, PathMode, ShellKind } from './types';

export const PATH_MIME = 'application/x-ajz-path';
export const MAX_DROP_ITEMS = 100;
export const MAX_DROP_PATH = 4096;
const MAX_PAYLOAD_CHARS = 1_000_000;
/** The inserted text of one drop never grows beyond this (a terminal input line is not a place for a book). */
export const MAX_DROP_TEXT = 32_768;

export type DropKind = 'file' | 'dir';
/** What the tree puts into the drag: only identifiers and the project-relative path, resolved by the receiver. */
export interface PathItem { kind: DropKind; projectId: string; relPath: string; absPath?: string }

/**
 * C0/C1 controls (an ESC would let a name end a bracketed paste early), the Unicode line separators, and the invisible or
 * direction-changing formatting characters (zero-width, bidi marks, embeddings, overrides, isolates, BOM) that make a name read as another one.
 */
export const hasControlChars = (text: string): boolean => /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(text);

/** A project-relative path with forward slashes: no root, no drive, no "." or ".." segments, no control characters. */
export function validRelPath(path: unknown, platform: AppPlatform = 'linux'): path is string {
  if (typeof path !== 'string' || !path || path.length > MAX_DROP_PATH || hasControlChars(path)) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  if (platform === 'win32' && /[\\:]/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function buildPathPayload(
  projectId: string, projectRoot: string, entries: Array<{ relPath: string; kind: 'directory' | 'file' | 'symlink' | undefined }>, platform: AppPlatform,
): string {
  const items: PathItem[] = entries.slice(0, MAX_DROP_ITEMS).map((entry) => ({
    kind: entry.kind === 'directory' ? 'dir' : 'file',
    projectId,
    relPath: entry.relPath,
    absPath: fullProjectPath(projectRoot, entry.relPath, platform),
  }));
  return JSON.stringify({ v: 1, items, ...(entries.length > MAX_DROP_ITEMS ? { cut: true } : {}) });
}

export interface ParsedPayload {
  items: PathItem[];
  /** Entries refused as malformed or unsafe. */
  rejected: number;
  /** More than MAX_DROP_ITEMS were dragged: only the first ones are here (the receiver says so). */
  cut: boolean;
}

/** Reads the drag payload. Null when it is not ours at all; otherwise the usable items and how many were refused. */
export function parsePathPayload(raw: unknown, platform: AppPlatform = 'linux'): ParsedPayload | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_PAYLOAD_CHARS) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const list = Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : [data];
  if (!list.length) return null;
  const items: PathItem[] = [];
  const seen = new Set<string>();
  const cut = list.length > MAX_DROP_ITEMS || (data as { cut?: unknown }).cut === true;
  let rejected = 0;
  for (const entry of list.slice(0, MAX_DROP_ITEMS)) {
    const item = entry as Partial<PathItem> | null;
    const ok = !!item && typeof item === 'object'
      && (item.kind === 'file' || item.kind === 'dir')
      && typeof item.projectId === 'string' && item.projectId.length > 0 && item.projectId.length <= 200 && !hasControlChars(item.projectId)
      && validRelPath(item.relPath, platform)
      && (item.absPath === undefined || (typeof item.absPath === 'string' && item.absPath.length <= MAX_DROP_PATH));
    if (!ok) { rejected++; continue; }
    const key = `${item.projectId}\0${item.relPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: item!.kind as DropKind, projectId: item!.projectId!, relPath: item!.relPath!, absPath: undefined });
  }
  return { items, rejected, cut };
}

const separatorOf = (platform: AppPlatform) => (platform === 'win32' ? '\\' : '/');
const slashes = (path: string, platform: AppPlatform) => (platform === 'win32' ? path.replace(/\\/g, '/') : path);

/** `abs` relative to `cwd` with forward slashes when it lies inside it ("." for the folder itself); otherwise null. */
export function relativeInside(cwd: string, abs: string, platform: AppPlatform): string | null {
  const strip = (path: string) => slashes(path, platform).replace(/\/+$/, '');
  const base = strip(cwd);
  const target = strip(abs);
  const fold = (text: string) => (platform === 'win32' ? text.toLowerCase() : text);
  if (fold(target) === fold(base)) return '.';
  return fold(target).startsWith(`${fold(base)}/`) ? target.slice(base.length + 1) : null;
}

/** PowerShell single-quoted literal. Besides the apostrophe, PowerShell treats the typographic single quotes as quote characters. */
export const psLiteral = (text: string): string => `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
const posixLiteral = (text: string): string => `'${text.replace(/'/g, `'"'"'`)}'`;

/** Quotes a path for a shell; null when the shell has no way to express it (cmd: a double quote, and `%`, which cmd expands even inside quotes). */
export function quoteForShell(text: string, shell: ShellKind): string | null {
  if (shell === 'cmd') return text.includes('"') || text.includes('%') ? null : `"${text}"`;
  return shell === 'zsh' || shell === 'bash' ? posixLiteral(text) : psLiteral(text);
}

export type DropTarget = 'claude' | 'codex' | 'shell';

/** What the user may force for a shell cell (Cell.pathMode); no override means "auto". */
export const PATH_MODES: readonly PathMode[] = ['claude', 'codex', 'shell'];
export const normalizePathMode = (value: unknown): PathMode | undefined => (PATH_MODES as readonly unknown[]).includes(value) ? (value as PathMode) : undefined;

/**
 * The format of the inserted paths. A real agent cell always gets its agent's format; a shell cell gets the user's override,
 * else the agent that was seen starting in it (see agentInfer.ts), else the quoted shell format.
 */
export function resolveDropTarget(cli: CliKind, override: unknown, inferred: 'claude' | 'codex' | null): DropTarget {
  if (cli !== 'shell') return cli;
  return normalizePathMode(override) ?? inferred ?? 'shell';
}

export interface DropText { text: string; /** Items left out (control characters, too long, not expressible). */ skipped: number }

/**
 * The text typed (never submitted) into a cell for the dropped items.
 *  - Claude: `@path ` (documented @ mention, relative to the cell's folder when inside it; `@"a b"` when the path has whitespace).
 *  - Codex: the plain path (its composer inserts plain paths too; a literal @ is not an attachment), double-quoted with whitespace.
 *  - Shell: the absolute path, quoted for the cell's shell.
 * Folders get a trailing separator in the agent forms.
 */
export function buildPathText(
  target: DropTarget, items: Array<{ kind: DropKind; abs: string }>, opts: { cwd: string; platform: AppPlatform; shell: ShellKind },
): DropText {
  const parts: string[] = [];
  let skipped = 0;
  let length = 0;
  for (const item of items) {
    const stripped = item.abs.replace(/[\\/]+$/, '');
    const abs = !stripped || /^[A-Za-z]:$/.test(stripped) ? item.abs : stripped;
    let token: string | null;
    if (!abs || abs.length > MAX_DROP_PATH || hasControlChars(abs)) token = null;
    else if (target === 'shell') token = quoteForShell(abs, opts.shell);
    else {
      const inside = relativeInside(opts.cwd, abs, opts.platform);
      const base = inside ?? abs;
      const path = item.kind === 'dir' ? (base.endsWith('/') || base.endsWith('\\') ? base : base + (inside === null ? separatorOf(opts.platform) : '/')) : base;
      const spaced = /\s/.test(path);
      if (spaced && path.includes('"')) token = path; // cannot be quoted: the plain path still tells the agent what is meant
      else if (spaced) token = target === 'claude' ? `@"${path}"` : `"${path}"`;
      else token = target === 'claude' ? `@${path}` : path;
    }
    if (token === null || length + token.length + 1 > MAX_DROP_TEXT) { skipped++; continue; }
    parts.push(token);
    length += token.length + 1;
  }
  return { text: parts.length ? `${parts.join(' ')} ` : '', skipped };
}

/** The first MAX_DROP_ITEMS of a list and whether the rest was left out (the caller says so; nothing is cut silently). */
export function capItems<T>(items: readonly T[]): { items: T[]; cut: boolean } {
  return { items: items.slice(0, MAX_DROP_ITEMS), cut: items.length > MAX_DROP_ITEMS };
}

/**
 * The absolute path inserted for a dragged project file. A cell that runs in a worktree of the same project sees that
 * checkout, not the main one: the same relative path inside the worktree is used when the file exists there, otherwise
 * the main checkout's file (an absolute path outside the cell's folder).
 */
export function dropAbsPath(
  a: { projectPath: string; relPath: string; sameProject: boolean; worktreePath?: string; existsInWorktree?: boolean; platform: AppPlatform },
): string {
  const root = a.sameProject && a.worktreePath && a.existsInWorktree ? a.worktreePath : a.projectPath;
  return fullProjectPath(root, a.relPath, a.platform);
}

export type DropBlock = 'held' | 'error' | 'starting' | 'exited';

/** Why a cell cannot take the dropped paths right now (null: it can). */
export function dropBlock(cell: { held: boolean; error: boolean; started: boolean; status: CellStatus }): DropBlock | null {
  if (cell.held) return 'held';
  if (cell.error) return 'error';
  if (!cell.started) return 'starting';
  return cell.status === 'exited' ? 'exited' : null;
}
