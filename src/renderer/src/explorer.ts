// State and commands of the Files panel: expansion, selection, clipboard and every file operation
// (rename, move, copy, paste, duplicate, create, trash). The filesystem work itself happens in the main process.
import { create } from 'zustand';
import {
  baseName, hasGitSegment, isSameOrDescendant, parentPath, retargetByMoves, summarizeNames, topLevelPaths, validateEntryName,
  type ConflictPolicy, type FileMoveRecord, type FileOpRequest, type FileOpResult,
} from '../../shared/fileOps';
import { fullProjectPath } from '../../shared/platform';
import { forgetDeletedFiles, holdTreeFocus, openFile, refreshReplacedFiles, retargetOpenFiles } from './files';
import { tr } from './i18n';
import { translateError } from '../../shared/i18n';
import { askChoice, askText, getS, setUi, toast, update } from './store';
import { useSshStore } from './sshStore';
import { switchProject } from './actions';

export interface Selection { paths: string[]; anchor: string | null }
interface Clipboard { projectId: string; paths: string[]; mode: 'copy' | 'cut'; text: string }
interface Busy { opId: string; entries: number; bytes: number }

interface ExplorerStore {
  expanded: Record<string, string[]>;
  selection: Record<string, Selection>;
  clipboard: Clipboard | null;
  renaming: { projectId: string; path: string } | null;
  reveal: { projectId: string; path: string; nonce: number } | null;
  /** Bumped after every change on disk: every open folder reloads its listing. */
  refresh: number;
  busy: Busy | null;
  undo: Array<{ projectId: string; moves: FileMoveRecord[] }>;
}

export const useExplorer = create<ExplorerStore>(() => ({
  expanded: {}, selection: {}, clipboard: null, renaming: null, reveal: null, refresh: 0, busy: null, undo: [],
}));
const set = useExplorer.setState;
const get = useExplorer.getState;
const language = () => getS().settings.language;
const errorText = (message: string) => {
  const lang = language();
  return lang ? translateError(lang, message) : message;
};
const platform = () => window.mc.platform;

/** The shown tree scrolls its selected row into view and focuses it (the list is virtual: the row may not exist yet). */
let focusSelectedRow: (() => boolean) | null = null;
export function registerTreeFocus(fn: (() => boolean) | null): void { focusSelectedRow = fn; }

/** After a dialog closed focus is lost: bring it back to the tree (only when nothing else took it) so shortcuts keep working. */
function refocusTree(): void {
  window.setTimeout(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    if (focusSelectedRow?.()) return;
    document.querySelector<HTMLElement>('.explorer-tree .tree-rows .file-entry.selected')?.focus({ preventScroll: true });
  }, 120);
}

export const bumpRefresh = (): void => set((s) => ({ refresh: s.refresh + 1 }));

// ---------- expansion and selection ----------

export const expandedSet = (projectId: string): Set<string> => new Set(get().expanded[projectId] ?? []);
export function setExpanded(projectId: string, paths: Iterable<string>): void {
  set((s) => ({ expanded: { ...s.expanded, [projectId]: [...new Set(paths)] } }));
}
export function toggleFolder(projectId: string, path: string, open?: boolean): void {
  const next = expandedSet(projectId);
  if (open ?? !next.has(path)) next.add(path); else next.delete(path);
  setExpanded(projectId, next);
}
export function expandAncestors(projectId: string, path: string): void {
  const next = expandedSet(projectId);
  for (let dir = parentPath(path); dir; dir = parentPath(dir)) next.add(dir);
  setExpanded(projectId, next);
}
export function selectPaths(projectId: string, paths: string[], anchor: string | null = paths[0] ?? null): void {
  set((s) => ({ selection: { ...s.selection, [projectId]: { paths, anchor } } }));
}
export const selectedPaths = (projectId: string): string[] => get().selection[projectId]?.paths ?? [];

/** Switches the left panel to Files, expands the folders down to `path`, selects it and scrolls it into view. */
export function locateInFiles(projectId: string, path: string): void {
  if (getS().activeProjectId !== projectId) switchProject(projectId);
  update((st) => st.sidebarCollapsed ? { ...st, sidebarCollapsed: false } : st);
  // SSH mode ends (the side panel would show the SSH navigation instead of Files); the SSH view stays open as a tab.
  useSshStore.setState({ viewActive: false });
  setUi({ sidebarView: 'files' });
  expandAncestors(projectId, path);
  selectPaths(projectId, [path], path);
  set({ reveal: { projectId, path, nonce: Date.now() } });
}

// ---------- applying results to the UI ----------

function applyMoves(projectId: string, moves: FileMoveRecord[], remember = true, replaced: string[] = []): void {
  if (!moves.length && !replaced.length) return;
  holdTreeFocus();
  retargetOpenFiles(projectId, moves, replaced);
  if (!moves.length) return;
  set((s) => ({
    expanded: { ...s.expanded, [projectId]: [...new Set((s.expanded[projectId] ?? []).map((p) => retargetByMoves(p, moves)))] },
    clipboard: s.clipboard && s.clipboard.projectId === projectId ? { ...s.clipboard, paths: s.clipboard.paths.map((p) => retargetByMoves(p, moves)) } : s.clipboard,
    undo: remember ? [...s.undo, { projectId, moves }].slice(-30) : s.undo,
  }));
}

let gitWarned = false;
async function confirmGit(paths: string[]): Promise<boolean> {
  if (gitWarned || !paths.some(hasGitSegment)) return true;
  const choice = await askChoice(tr('Folder .git'), tr('Ta operacja dotyczy folderu .git. Zmiany w nim mogą uszkodzić repozytorium. Kontynuować?'), [
    { label: tr('Kontynuuj'), value: 'go', danger: true, primary: true },
  ]);
  if (choice !== 'go') { refocusTree(); return false; }
  gitWarned = true;
  return true;
}

function names(paths: string[]): string {
  const { shown, more } = summarizeNames(paths.map(baseName));
  return shown.join(', ') + (more ? ` +${more}` : '');
}

const formatSize = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

let removeProgress: (() => void) | null = null;
function watchProgress(opId: string): () => void {
  removeProgress?.();
  let timer: number | undefined = window.setTimeout(() => set({ busy: { opId, entries: 0, bytes: 0 } }), 350);
  const off = window.mc.on('fs:progress', (progress) => {
    if (progress.opId === opId && get().busy) set({ busy: { opId, entries: progress.entries, bytes: progress.bytes } });
  });
  const stop = () => { window.clearTimeout(timer); timer = undefined; off(); set({ busy: null }); removeProgress = null; };
  removeProgress = stop;
  return stop;
}
export function cancelBusy(): void {
  const busy = get().busy;
  if (busy) window.mc.cancelFileOp(busy.opId);
}

// ---------- move and copy ----------

export interface TransferInput { projectId: string; kind: 'move' | 'copy'; paths: string[]; destination: string }

/** Moves or copies items into a folder; asks about conflicts and very large copies. Returns the moved/copied pairs. */
export async function transferEntries(input: TransferInput): Promise<FileMoveRecord[]> {
  const { projectId, kind, destination } = input;
  const paths = topLevelPaths(input.paths);
  if (!paths.length) return [];
  if (kind === 'move' && paths.every((p) => parentPath(p) === destination)) return [];
  if (!await confirmGit([...paths, destination])) return [];
  let conflict: ConflictPolicy = 'ask';
  let force = false;
  for (;;) {
    const opId = crypto.randomUUID();
    const stop = kind === 'copy' ? watchProgress(opId) : () => undefined;
    let result: FileOpResult;
    try {
      const request: FileOpRequest = { kind, paths, destination, conflict, force, opId };
      result = await window.mc.transferProjectEntries(projectId, request);
    } catch (error) { stop(); toast(String(error), 'error'); return []; }
    stop();
    if (!result.ok) {
      if (result.code === 'conflict') {
        const choice = await askChoice(tr('Konflikt nazw'),
          tr('W folderze docelowym już istnieje: {names}. Zastąpiony element trafi do kosza.', { names: names(result.conflicts.map((c) => c.path)) }), [
            ...(result.conflicts.every((c) => c.internal) ? [] : [{ label: tr('Zastąp'), value: 'replace', danger: true }]),
            { label: tr('Zachowaj oba'), value: 'keepBoth', primary: true },
            { label: tr('Pomiń'), value: 'skip' },
          ]);
        if (choice !== 'replace' && choice !== 'keepBoth' && choice !== 'skip') { refocusTree(); return []; }
        conflict = choice;
        continue;
      }
      if (result.code === 'large') {
        const choice = await askChoice(tr('Duże kopiowanie'),
          tr('Kopiowanie obejmuje co najmniej {entries} elementów i {size}. Może to potrwać. Kontynuować?', { entries: result.entries, size: formatSize(result.bytes) }), [
            { label: tr('Kopiuj mimo to'), value: 'go', primary: true },
          ]);
        if (choice !== 'go') { refocusTree(); return []; }
        force = true;
        continue;
      }
      toast(errorText(result.error), 'error');
      return [];
    }
    if (kind === 'move') applyMoves(projectId, result.done, true, result.replaced);
    else refreshReplacedFiles(projectId, result.replaced);
    bumpRefresh();
    const targets = result.done.map((m) => m.to);
    if (targets.length) {
      const next = expandedSet(projectId);
      if (destination) next.add(destination);
      setExpanded(projectId, next);
      selectPaths(projectId, targets, targets[0]);
    }
    report(kind === 'copy' ? 'Skopiowano: {count}' : 'Przeniesiono: {count}', result);
    refocusTree();
    return result.done;
  }
}

function report(key: 'Skopiowano: {count}' | 'Przeniesiono: {count}', result: Extract<FileOpResult, { ok: true }>): void {
  if (result.failed.length) {
    const first = result.failed[0];
    toast(tr('Nie udało się: {name} ({error})', { name: baseName(first.path), error: errorText(first.error) }), 'error');
  } else if (result.notes.length) toast(tr('Pominięto linki symboliczne: {names}', { names: result.notes.slice(0, 4).join(', ') }));
  else if (result.cancelled) toast(tr('Operacja została anulowana.'));
  else if (result.skipped.length && !result.done.length) toast(tr('Pominięto: {count}', { count: result.skipped.length }));
  else if (result.done.length > 1) toast(tr(key, { count: result.done.length }));
}

// ---------- rename, create, delete ----------

export async function renameEntry(projectId: string, path: string, newName: string, remember = true): Promise<string | null> {
  const invalid = validateEntryName(newName, platform());
  if (invalid) { toast(tr(invalid as Parameters<typeof tr>[0]), 'error'); return null; }
  if (!await confirmGit([path])) return null;
  const result = await window.mc.renameProjectEntry(projectId, path, newName).catch((error) => ({ ok: false as const, error: String(error) }));
  if (!result.ok) { toast(errorText(result.error), 'error'); return null; }
  if (result.from !== result.to) applyMoves(projectId, [{ from: result.from, to: result.to }], remember);
  bumpRefresh();
  selectPaths(projectId, [result.to], result.to);
  refocusTree();
  return result.to;
}

export async function createEntry(projectId: string, directory: string, kind: 'file' | 'directory'): Promise<void> {
  const name = (await askText(tr(kind === 'file' ? 'Nazwa nowego pliku' : 'Nazwa nowego folderu')))?.trim();
  if (!name) return;
  const result = await window.mc.createProjectEntry(projectId, directory, name, kind).catch((error) => ({ ok: false as const, error: String(error) }));
  if (!result.ok) { toast(errorText(result.error), 'error'); return; }
  if (directory) { const next = expandedSet(projectId); next.add(directory); setExpanded(projectId, next); }
  bumpRefresh();
  selectPaths(projectId, [result.path], result.path);
  set({ reveal: { projectId, path: result.path, nonce: Date.now() } });
  if (kind === 'file') void openFile(projectId, result.path);
}

export async function trashEntries(projectId: string, input: string[]): Promise<void> {
  const paths = topLevelPaths(input);
  if (!paths.length) return;
  if (!await confirmGit(paths)) return;
  const choice = await askChoice(tr('Przenieść do kosza?'), tr('Do kosza trafi: {names}. Możesz to przywrócić z kosza systemowego.', { names: names(paths) }), [
    { label: tr('Przenieś do kosza'), value: 'trash', danger: true, primary: true },
  ]);
  if (choice !== 'trash') { refocusTree(); return; }
  const result = await window.mc.deleteProjectEntries(projectId, paths).catch((error) => ({ ok: false as const, error: String(error) }));
  if (!result.ok) { toast(errorText(result.error), 'error'); return; }
  if (result.trashed.length) forgetDeletedFiles(projectId, result.trashed);
  set((s) => ({
    selection: { ...s.selection, [projectId]: { paths: [], anchor: null } },
    clipboard: s.clipboard && s.clipboard.projectId === projectId ? { ...s.clipboard, paths: s.clipboard.paths.filter((p) => !result.trashed.some((t) => isSameOrDescendant(t, p))) } : s.clipboard,
    expanded: { ...s.expanded, [projectId]: (s.expanded[projectId] ?? []).filter((p) => !result.trashed.some((t) => isSameOrDescendant(t, p))) },
  }));
  bumpRefresh();
  if (result.failed.length) toast(tr('Nie udało się: {name} ({error})', { name: baseName(result.failed[0].path), error: errorText(result.failed[0].error) }), 'error');
  else toast(tr('Przeniesiono do kosza: {count}', { count: result.trashed.length }));
  refocusTree();
}

// ---------- clipboard ----------

/** Cut/copy remember the items; their full paths also go to the text clipboard (and tell us when it was replaced). */
export function copyToClipboard(projectId: string, paths: string[], mode: 'copy' | 'cut'): void {
  const project = getS().projects.find((p) => p.id === projectId);
  const top = topLevelPaths(paths);
  if (!project || !top.length) return;
  const text = top.map((p) => fullProjectPath(project.path, p, platform())).join('\n');
  window.mc.clipboardWrite(text);
  set({ clipboard: { projectId, paths: top, mode, text } });
}

export async function pasteInto(projectId: string, directory: string): Promise<void> {
  const clip = get().clipboard;
  // When something else was copied to the text clipboard since, there is nothing of ours to paste.
  const current = clip ? await window.mc.clipboardRead().catch(() => clip.text) : '';
  if (!clip || clip.projectId !== projectId || !clip.paths.length || current !== clip.text) { toast(tr('Nie ma czego wkleić.')); return; }
  const done = await transferEntries({ projectId, kind: clip.mode === 'cut' ? 'move' : 'copy', paths: clip.paths, destination: directory });
  if (clip.mode === 'cut' && done.length) set({ clipboard: null });
}

export async function duplicateEntries(projectId: string, paths: string[]): Promise<void> {
  const top = topLevelPaths(paths);
  const byParent = new Map<string, string[]>();
  for (const path of top) byParent.set(parentPath(path), [...(byParent.get(parentPath(path)) ?? []), path]);
  for (const [parent, group] of byParent) await transferEntries({ projectId, kind: 'copy', paths: group, destination: parent });
}

/** Undo of the last rename or move of this session (Ctrl+Z in the tree). */
export async function undoLast(projectId: string): Promise<void> {
  const stack = get().undo;
  let index = -1;
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].projectId === projectId) { index = i; break; }
  if (index < 0) { toast(tr('Nie ma czego cofnąć.')); return; }
  const entry = stack[index];
  set({ undo: stack.filter((_, i) => i !== index) });
  const restored: FileMoveRecord[] = [];
  for (const move of [...entry.moves].reverse()) {
    const original = parentPath(move.from);
    if (parentPath(move.to) === original) {
      const to = await window.mc.renameProjectEntry(projectId, move.to, baseName(move.from));
      if (!to.ok) { toast(errorText(to.error), 'error'); break; }
      restored.push({ from: move.to, to: move.from });
      continue;
    }
    const result = await window.mc.transferProjectEntries(projectId, { kind: 'move', paths: [move.to], destination: original, conflict: 'ask' });
    if (!result.ok || result.failed.length) { toast(errorText(result.ok ? result.failed[0].error : result.error), 'error'); break; }
    for (const done of result.done) {
      restored.push(done);
      if (baseName(done.to) !== baseName(move.from)) {
        const renamed = await window.mc.renameProjectEntry(projectId, done.to, baseName(move.from));
        if (renamed.ok) restored[restored.length - 1] = { from: done.from, to: renamed.to };
      }
    }
  }
  if (!restored.length) return;
  applyMoves(projectId, restored, false);
  bumpRefresh();
  selectPaths(projectId, restored.map((m) => m.to));
  toast(tr('Cofnięto ostatnią operację.'));
}

const kinds = new Map<string, 'directory' | 'file' | 'symlink'>();
/** The tree remembers what each listed path is, so keyboard commands can pick a target folder. */
export function rememberKinds(projectId: string, entries: Array<{ path: string; kind: 'directory' | 'file' | 'symlink' }>): void {
  for (const entry of entries) kinds.set(projectId + ':' + entry.path, entry.kind);
}
export const kindOf = (projectId: string, path: string) => kinds.get(projectId + ':' + path);

/** Folder that receives a paste or a new item: the selected folder, the parent of a selected file, or the root. */
export function targetDirectory(projectId: string): string {
  const first = selectedPaths(projectId)[0];
  if (!first) return '';
  return kindOf(projectId, first) === 'directory' ? first : parentPath(first);
}
