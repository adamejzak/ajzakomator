import { useEffect } from 'react';
import { activeProject, activeTab, findCell, getProfile, updateCell } from '../../shared/state';
import { focusCell, refreshSessionTitles, resetStarted, setAliveAtStart } from './actions';
import { CommandPalette } from './components/CommandPalette';
import { ContextMenuHost } from './components/ContextMenu';
import { GridView } from './components/GridView';
import { Modals } from './components/Modals';
import { Sidebar } from './components/Sidebar';
import { SnippetPanel } from './components/SnippetPanel';
import { TitleBar } from './components/TitleBar';
import { useShortcuts } from './shortcuts';
import { getS, getUi, setUi, toast, update, useStore } from './store';
import { terminals } from './terminals/TerminalManager';

let booted = false;

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  terminals.setWindowsBuild(window.mc.windowsBuild);
  const [state, alive] = await Promise.all([window.mc.loadState(), window.mc.aliveCells()]);
  setAliveAtStart(alive);
  useStore.getState().init(state);

  const missing: Record<string, true> = {};
  await Promise.all(state.projects.map(async (p) => {
    if (!(await window.mc.pathExists(p.path))) missing[p.id] = true;
  }));
  setUi({ missingPaths: missing, focusedCellId: activeTab(activeProject(state))?.cells[0]?.id ?? null });
  refreshSessionTitles(activeProject(state)?.path);
  let lastProject = state.activeProjectId;
  useStore.subscribe((st) => {
    if (st.s.activeProjectId === lastProject) return;
    lastProject = st.s.activeProjectId;
    refreshSessionTitles(activeProject(st.s)?.path);
  });

  window.mc.on('cell:hook', (cellId, event) => terminals.hook(cellId, event));
  window.mc.on('cell:session', (cellId, session) => update((s) => updateCell(s, cellId, { session })));
  window.mc.on('cell:spawnError', (cellId, message) => setUi((ui) => ({ cellErrors: { ...ui.cellErrors, [cellId]: message } })));
  window.mc.on('focus-cell', (cellId) => focusCell(cellId));
  window.mc.on('ptyhost:crashed', () => {
    toast('Proces terminali się zrestartował — wznawiam rozmowy', 'error');
    resetStarted();
  });
  window.mc.on('app:before-quit', () => window.mc.saveState(getS()));

  terminals.onStatus((cellId, status) => {
    setUi((ui) => ({ statuses: { ...ui.statuses, [cellId]: status } }));
    if (status !== 'waiting') return;
    maybeNotify(cellId);
    bindCodexSession(cellId);
    // A turn finished: the agent may have (re)titled the conversation.
    const found = findCell(getS(), cellId);
    if (found && !found.cell.name) refreshSessionTitles(found.project.path, 3000);
  });
  terminals.onExit((cellId) => {
    // Shell exited (e.g. user typed `exit`) — keep the cell, offer a restart from its header.
    setUi((ui) => ({ statuses: { ...ui.statuses, [cellId]: 'exited' } }));
  });
}

function isVisible(cellId: string): boolean {
  const tab = activeTab(activeProject(getS()));
  if (!tab?.cells.some((c) => c.id === cellId)) return false;
  const max = getUi().maximizedCellId;
  return !max || max === cellId;
}

/** A Codex cell just finished a turn: its session file is fresh, so bind it if not known yet. */
function bindCodexSession(cellId: string): void {
  const found = findCell(getS(), cellId);
  if (!found || found.cell.session || getProfile(getS(), found.cell.profileId).cli !== 'codex') return;
  void window.mc.bindCodexSession(cellId, found.cell.worktree?.path ?? found.project.path);
}

function maybeNotify(cellId: string): void {
  const s = getS();
  if (!s.settings.notifications) return;
  if (document.hasFocus() && isVisible(cellId)) {
    if (terminals.isFocused(cellId)) terminals.acknowledge(cellId);
    return;
  }
  const found = findCell(s, cellId);
  if (!found) return;
  const profile = getProfile(s, found.cell.profileId);
  if (profile.cli === 'shell') return;
  const n = found.tab.cells.findIndex((c) => c.id === cellId) + 1;
  window.mc.notify({
    title: `${found.project.name} · ${found.tab.name} #${n}`,
    body: `${profile.name} czeka na Ciebie`,
    cellId,
  });
}

export function App() {
  const ready = useStore((st) => st.ready);
  const snippetsOpen = useStore((st) => st.s.snippetsOpen);
  useEffect(() => void boot(), []);
  useShortcuts();
  if (!ready) return <div className="app" />;
  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <div className="main">
          <GridView />
        </div>
        {snippetsOpen && <SnippetPanel />}
      </div>
      <CommandPalette />
      <Modals />
      <ContextMenuHost />
      <Toast />
    </div>
  );
}

function Toast() {
  const t = useStore((st) => st.ui.toast);
  if (!t) return null;
  return <div className={`toast ${t.kind}`}>{t.text}</div>;
}

