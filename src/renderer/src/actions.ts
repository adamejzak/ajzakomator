// High-level user actions: they combine state transitions with pty/terminal side effects.
import type { GridLayout } from '../../shared/layout';
import { layoutForCount } from '../../shared/layout';
import {
  activeProject, activeTab, addCell, addProject, addTab, closeTab as closeTabState, findCell, getProfile,
  removeCell as removeCellState, removeProject as removeProjectState, restoreTab, setActiveProject, setActiveTab,
  uid, updateCell, updateSettings,
} from '../../shared/state';
import type { CellSession, Profile, SessionInfo, Snippet, Tab, Worktree } from '../../shared/types';
import { askChoice, getS, getUi, setUi, toast, update } from './store';
import { terminals } from './terminals/TerminalManager';

/** Cells whose pty was started (or found alive) during this renderer session. */
const started = new Set<string>();
let aliveAtStart = new Set<string>();

export function setAliveAtStart(ids: string[]): void {
  aliveAtStart = new Set(ids);
}

export function resetStarted(): void {
  started.clear();
  aliveAtStart.clear();
  setUi((ui) => ({ epoch: ui.epoch + 1 }));
}

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

// ── cells ───────────────────────────────────────────────────────────────────

export function ensureTerminal(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found) return;
  const profile = getProfile(getS(), found.cell.profileId);
  terminals.ensure(cellId, {
    fontSize: found.cell.fontSize ?? getS().settings.fontSize,
    agent: profile.cli !== 'shell',
    onFontSize: (size) => update((s) => updateCell(s, cellId, { fontSize: size })),
  });
}

/** Starts the cell's terminal once per session (resuming its conversation when it has one). */
export function ensureStarted(cellId: string): void {
  if (started.has(cellId)) return;
  started.add(cellId);
  ensureTerminal(cellId);
  if (aliveAtStart.has(cellId)) return; // pty survived a renderer reload; output is replayed
  const cell = findCell(getS(), cellId)?.cell;
  void spawnCell(cellId, cell?.session ? 'resume' : 'new');
}

export async function spawnCell(cellId: string, mode: 'new' | 'resume'): Promise<void> {
  const found = findCell(getS(), cellId);
  if (!found) return;
  const { project, cell } = found;
  const profile = getProfile(getS(), cell.profileId);
  started.add(cellId);
  ensureTerminal(cellId);

  let sessionId: string | undefined;
  const sameCli = cell.session && cell.session.cli === profile.cli;
  if (mode === 'resume' && sameCli) sessionId = cell.session!.id;
  else mode = 'new';

  if (mode === 'new') {
    let session: CellSession | undefined;
    if (profile.cli === 'claude') {
      sessionId = uid();
      session = { cli: 'claude', id: sessionId };
    }
    update((s) => updateCell(s, cellId, { session }));
  }

  terminals.prepareSpawn(cellId);
  setUi((ui) => {
    const { [cellId]: _, ...rest } = ui.cellErrors;
    return { cellErrors: rest };
  });
  const { cols, rows } = terminals.size(cellId);
  const r = await window.mc.spawnCell({
    cellId, cwd: cell.worktree?.path ?? project.path, cols, rows, profile, mode, sessionId,
  });
  if (!r.ok) setUi((ui) => ({ cellErrors: { ...ui.cellErrors, [cellId]: r.error } }));
}

export function restartCell(cellId: string, mode: 'new' | 'resume'): void {
  void spawnCell(cellId, mode);
  requestAnimationFrame(() => terminals.focus(cellId));
}

export function changeCellProfile(cellId: string, profileId: string): void {
  update((s) => updateCell(s, cellId, { profileId, session: undefined }));
  update((s) => updateSettings(s, { lastProfileId: profileId }));
  ensureTerminal(cellId);
  restartCell(cellId, 'new');
}

export async function removeCell(cellId: string): Promise<void> {
  const found = findCell(getS(), cellId);
  if (!found) return;
  const { project, tab, cell } = found;
  if (tab.cells.length === 1) return closeTab(project.id, tab.id);
  let removeWt = false;
  if (cell.worktree) {
    const choice = await askChoice('Zamknąć komórkę z worktree?', `${cell.worktree.path}\nbranch ${cell.worktree.branch}`, [
      { label: 'Zostaw worktree', value: 'keep', primary: true },
      { label: 'Usuń worktree i branch', value: 'remove', danger: true },
    ]);
    if (!choice) return;
    removeWt = choice === 'remove';
  }
  killAndDispose(cellId);
  update((s) => removeCellState(s, project.id, tab.id, cellId));
  if (removeWt && cell.worktree) await deleteWorktree(project.path, cell.worktree);
}

async function deleteWorktree(projectPath: string, wt: Worktree): Promise<void> {
  try {
    await window.mc.removeWorktree(projectPath, wt, true);
    toast(`Usunięto worktree ${wt.branch}`);
  } catch (e) {
    toast(`Nie udało się usunąć worktree: ${(e as Error).message}`, 'error');
  }
}

function killAndDispose(cellId: string): void {
  window.mc.killCell(cellId);
  terminals.dispose(cellId);
  started.delete(cellId);
  setUi((ui) => {
    const { [cellId]: _s, ...statuses } = ui.statuses;
    return {
      statuses,
      focusedCellId: ui.focusedCellId === cellId ? null : ui.focusedCellId,
      maximizedCellId: ui.maximizedCellId === cellId ? null : ui.maximizedCellId,
    };
  });
}

export function focusCell(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found) return;
  update((s) => setActiveTab(setActiveProject(s, found.project.id), found.project.id, found.tab.id));
  setUi((ui) => ({
    focusedCellId: cellId,
    maximizedCellId: ui.maximizedCellId && found.tab.cells.some((c) => c.id === ui.maximizedCellId) ? ui.maximizedCellId : null,
  }));
  requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(cellId)));
  terminals.acknowledge(cellId);
}

export function moveFocus(dx: number, dy: number): void {
  const tab = activeTab(activeProject(getS()));
  if (!tab) return;
  const idx = Math.max(0, tab.cells.findIndex((c) => c.id === getUi().focusedCellId));
  const cur = tab.layout.areas[idx];
  if (!cur) return;
  const cx = cur.col + cur.colSpan / 2;
  const cy = cur.row + cur.rowSpan / 2;
  let best = -1;
  let bestDist = Infinity;
  tab.layout.areas.forEach((a, i) => {
    if (i === idx) return;
    const ax = a.col + a.colSpan / 2;
    const ay = a.row + a.rowSpan / 2;
    const ddx = ax - cx;
    const ddy = ay - cy;
    if ((dx && Math.sign(ddx) !== dx) || (dy && Math.sign(ddy) !== dy)) return;
    const dist = Math.abs(ddx) * (dx ? 1 : 3) + Math.abs(ddy) * (dy ? 1 : 3);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  if (best >= 0 && tab.cells[best]) focusCell(tab.cells[best].id);
}

export function toggleMaximize(cellId?: string): void {
  const id = cellId ?? getUi().focusedCellId;
  if (!id) return;
  setUi((ui) => ({ maximizedCellId: ui.maximizedCellId === id ? null : id, focusedCellId: id }));
  requestAnimationFrame(() => terminals.focus(id));
}

// ── projects ────────────────────────────────────────────────────────────────

export async function createProject(): Promise<void> {
  const path = await window.mc.pickFolder();
  if (!path) return;
  const existing = getS().projects.find((p) => p.path.toLowerCase() === path.toLowerCase());
  if (existing) return switchProject(existing.id);
  update((s) => addProject(s, { name: basename(path), path }));
}

export function switchProject(projectId: string): void {
  update((s) => setActiveProject(s, projectId));
  const p = getS().projects.find((x) => x.id === projectId);
  const tab = activeTab(p ?? null);
  const cellId = tab?.cells[0]?.id;
  setUi({ maximizedCellId: null, focusedCellId: cellId ?? null });
  if (cellId) requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(cellId)));
}

export async function removeProject(projectId: string): Promise<void> {
  const p = getS().projects.find((x) => x.id === projectId);
  if (!p) return;
  const live = p.tabs.reduce((n, t) => n + t.cells.length, 0);
  const choice = await askChoice(
    `Usunąć projekt „${p.name}” z listy?`,
    `Folder na dysku zostaje nietknięty.${live ? ` Zamkniętych zostanie ${live} terminali.` : ''}`,
    [{ label: 'Usuń z listy', value: 'yes', danger: true }],
  );
  if (choice !== 'yes') return;
  for (const t of p.tabs) for (const c of t.cells) killAndDispose(c.id);
  update((s) => removeProjectState(s, projectId));
}

export async function relocateProject(projectId: string): Promise<void> {
  const path = await window.mc.pickFolder();
  if (!path) return;
  update((s) => ({ ...s, projects: s.projects.map((p) => (p.id === projectId ? { ...p, path } : p)) }));
  setUi((ui) => {
    const { [projectId]: _, ...rest } = ui.missingPaths;
    return { missingPaths: rest };
  });
}

// ── tabs ────────────────────────────────────────────────────────────────────

export interface TabSpecCell {
  profileId: string;
  worktree: boolean;
  session?: CellSession;
}

export async function openTab(projectId: string, layout: GridLayout, cells: TabSpecCell[], name?: string): Promise<void> {
  const project = getS().projects.find((p) => p.id === projectId);
  if (!project) return;
  const tabName = name ?? undefined;
  const specs: Array<{ profileId: string; worktree?: Worktree; session?: CellSession }> = [];
  for (let i = 0; i < layout.areas.length; i++) {
    const spec = cells[i] ?? cells[cells.length - 1] ?? { profileId: getS().settings.lastProfileId, worktree: false };
    let worktree: Worktree | undefined;
    if (spec.worktree) {
      try {
        worktree = await window.mc.createWorktree(project.path, `${tabName ?? 'grid'}-${i + 1}`);
      } catch (e) {
        toast(`Worktree nie powstał (komórka ${i + 1}): ${(e as Error).message}`, 'error');
      }
    }
    specs.push({ profileId: spec.profileId, worktree, session: spec.session });
  }
  update((s) => setActiveProject(addTab(s, projectId, { name: tabName, layout, cells: specs }), projectId));
  const tab = activeTab(getS().projects.find((p) => p.id === projectId) ?? null);
  if (tab?.cells[0]) focusCell(tab.cells[0].id);
  update((s) => updateSettings(s, { lastProfileId: specs[0]?.profileId ?? s.settings.lastProfileId }));
}

export function quickTab(profileId?: string): void {
  const p = activeProject(getS());
  if (!p) return void createProject();
  void openTab(p.id, layoutForCount(1), [{ profileId: profileId ?? getS().settings.lastProfileId, worktree: false }]);
}

export async function addAgent(profileId: string, worktree = false): Promise<void> {
  const p = activeProject(getS());
  if (!p) return void createProject();
  const tab = activeTab(p);
  if (!tab) return openTab(p.id, layoutForCount(1), [{ profileId, worktree }]);
  if (tab.cells.length >= 20) return toast('Siatka ma już maksymalnie 20 komórek', 'error');
  let wt: Worktree | undefined;
  if (worktree) {
    try {
      wt = await window.mc.createWorktree(p.path, `${tab.name}-${tab.cells.length + 1}`);
    } catch (e) {
      toast(`Worktree nie powstał: ${(e as Error).message}`, 'error');
    }
  }
  update((s) => updateSettings(addCell(s, p.id, tab.id, profileId, { worktree: wt }), { lastProfileId: profileId }));
  const newTab = activeTab(activeProject(getS()));
  const cell = newTab?.cells[newTab.cells.length - 1];
  if (cell) focusCell(cell.id);
}

export function closeTab(projectId: string, tabId: string): void {
  const tab = getS().projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  for (const c of tab.cells) killAndDispose(c.id);
  update((s) => closeTabState(s, projectId, tabId));
  toast(`Zakładka „${tab.name}” trafiła do historii`);
}

export function restoreArchived(projectId: string, archivedId: string): void {
  update((s) => setActiveProject(restoreTab(s, projectId, archivedId), projectId));
  const tab = activeTab(getS().projects.find((p) => p.id === projectId) ?? null);
  if (tab?.cells[0]) focusCell(tab.cells[0].id);
}

export function cycleTab(dir: 1 | -1): void {
  const p = activeProject(getS());
  if (!p || p.tabs.length < 2) return;
  const idx = p.tabs.findIndex((t) => t.id === p.activeTabId);
  const next = p.tabs[(idx + dir + p.tabs.length) % p.tabs.length];
  selectTab(p.id, next);
}

export function selectTab(projectId: string, tab: Tab): void {
  update((s) => setActiveTab(s, projectId, tab.id));
  setUi({ maximizedCellId: null, focusedCellId: tab.cells[0]?.id ?? null });
  const id = tab.cells[0]?.id;
  if (id) requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(id)));
}

// ── sessions ────────────────────────────────────────────────────────────────

function profileFor(cli: 'claude' | 'codex'): Profile {
  const s = getS();
  const last = s.profiles.find((p) => p.id === s.settings.lastProfileId);
  return last?.cli === cli ? last : (s.profiles.find((p) => p.cli === cli) ?? getProfile(s, 'shell'));
}

export function resumeSession(info: SessionInfo, target: 'cell' | 'newCell' | 'newTab'): void {
  const p = activeProject(getS());
  if (!p) return;
  const profile = profileFor(info.cli);
  const session: CellSession = { cli: info.cli, id: info.id };
  const focused = getUi().focusedCellId;
  if (target === 'cell' && focused && findCell(getS(), focused)) {
    update((s) => updateCell(s, focused, { profileId: profile.id, session }));
    restartCell(focused, 'resume');
    return;
  }
  const tab = activeTab(p);
  if (target === 'newCell' && tab) {
    update((s) => addCell(s, p.id, tab.id, profile.id, { session }));
    const t = activeTab(activeProject(getS()));
    const cell = t?.cells[t.cells.length - 1];
    if (cell) focusCell(cell.id);
    return;
  }
  void openTab(p.id, layoutForCount(1), [{ profileId: profile.id, worktree: false, session }], info.title.slice(0, 24));
}

// ── snippets ────────────────────────────────────────────────────────────────

/** Pastes a snippet: into the focused cell, a given cell, or every cell of the active tab. */
export function sendSnippet(snippet: Snippet, target: 'focused' | 'all' | { cellId: string }): void {
  const tab = activeTab(activeProject(getS()));
  if (!tab) return toast('Najpierw otwórz grid w projekcie', 'error');
  let ids: string[];
  if (target === 'all') ids = tab.cells.map((c) => c.id);
  else if (target === 'focused') {
    const f = getUi().focusedCellId;
    ids = [f && tab.cells.some((c) => c.id === f) ? f : tab.cells[0].id];
  } else ids = [target.cellId];
  for (const id of ids) {
    ensureStarted(id);
    terminals.paste(id, snippet.text, snippet.autoSend);
  }
  if (ids.length === 1) focusCell(ids[0]);
}
