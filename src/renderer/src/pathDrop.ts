// Puts files and folders (dragged from the Files tree, or added from its context menu) into a cell's input, never submitting.
import { fullProjectPath } from '../../shared/platform';
import { buildPathText, dropBlock, parsePathPayload, validRelPath, type PathItem } from '../../shared/pathDrop';
import { activeProject, activeTab, findCell, getProfile } from '../../shared/state';
import { ensureStarted, focusCell, isStarted } from './actions';
import { kindOf } from './explorer';
import { tr } from './i18n';
import { getS, getUi, toast } from './store';
import { terminals } from './terminals/TerminalManager';

/** True while the cell would refuse the paths (shown on the drop hint). */
export function cellRefusesPaths(cellId: string): boolean {
  const ui = getUi();
  return dropBlock({ held: ui.heldCells[cellId] === true, error: !!ui.cellErrors[cellId], started: isStarted(cellId), status: ui.statuses[cellId] ?? 'idle' }) !== null;
}

/** Validated items of a drag payload (the raw string comes from the DOM and is untrusted). */
export const readDroppedPaths = (raw: string) => parsePathPayload(raw, window.mc.platform);

/**
 * Inserts the items at the cursor of the cell's input. Absolute paths are rebuilt here from the project that the item names;
 * whatever absolute path the drag carried is ignored.
 */
export function addPathsToCell(cellId: string, items: PathItem[], rejected = 0): void {
  const state = getS();
  const found = findCell(state, cellId);
  if (!found) return void toast(tr('Nie udało się dodać ścieżki.'), 'error');
  const ui = getUi();
  const block = dropBlock({ held: ui.heldCells[cellId] === true, error: !!ui.cellErrors[cellId], started: isStarted(cellId), status: ui.statuses[cellId] ?? 'idle' });
  if (block === 'starting') {
    ensureStarted(cellId);
    return void toast(tr('Komórka dopiero się uruchamia - upuść ścieżkę ponownie za chwilę.'));
  }
  if (block) return void toast(tr('Nie dodano ścieżki: komórka nie jest uruchomiona.'), 'error');

  const platform = window.mc.platform;
  const resolved: Array<{ kind: PathItem['kind']; abs: string }> = [];
  for (const item of items) {
    const project = state.projects.find((p) => p.id === item.projectId);
    if (!project) { rejected++; continue; }
    resolved.push({ kind: item.kind, abs: fullProjectPath(project.path, item.relPath, platform) });
  }
  const profile = getProfile(state, found.cell.profileId);
  const { text, skipped } = buildPathText(profile.cli, resolved, {
    cwd: found.cell.worktree?.path ?? found.project.path, platform, shell: state.settings.shell,
  });
  rejected += skipped;
  if (rejected > 0) toast(tr('Pominięto elementy, których nie można dodać: {count}', { count: rejected }), 'error');
  if (!text) return;
  terminals.paste(cellId, text, false);
  focusCell(cellId);
}

/** The focused cell of the visible grid (where "Add to conversation" from the tree sends its items), or null. */
export function focusedCellId(): string | null {
  const id = getUi().focusedCellId;
  return id && activeTab(activeProject(getS()))?.cells.some((cell) => cell.id === id) ? id : null;
}

/** "Add to conversation" for tree entries (project-relative paths): the same insertion as a drop on the focused cell. */
export function addTreePathsToFocusedCell(projectId: string, paths: string[]): void {
  const cellId = focusedCellId();
  if (!cellId) return;
  const valid = paths.filter((path) => validRelPath(path, window.mc.platform));
  const items: PathItem[] = valid.map((relPath) => ({ kind: kindOf(projectId, relPath) === 'directory' ? 'dir' : 'file', projectId, relPath }));
  addPathsToCell(cellId, items, paths.length - valid.length);
}
