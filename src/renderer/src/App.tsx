import { tr, useI18n } from './i18n';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { fitPanelWidths, MIN_WORKSPACE_WIDTH, type Panel } from '../../shared/panels';
import { activeProject, activeTab, findCell, getProfile, updateCell } from '../../shared/state';
import { ensureStarted, focusCell, refreshSessionTitles, resetStarted, releaseCellTerminal, setAliveAtStart } from './actions';
import { CommandPalette } from './components/CommandPalette';
import { ContextMenuHost } from './components/ContextMenu';
import { GridView } from './components/GridView';
import { LanguageSetup } from './components/LanguageSetup';
import { Modals } from './components/Modals';
import { Sidebar } from './components/Sidebar';
import { SnippetPanel } from './components/SnippetPanel';
import { TitleBar, WorkspaceTabs } from './components/TitleBar';
import { useShortcuts } from './shortcuts';
import { getS, getUi, setUi, toast, update, useStore } from './store';
import { terminals } from './terminals/TerminalManager';
import { AutomationPanel } from './components/AutomationPanel';
import { FileEditor } from './components/FileEditor';
import { useFileStore } from './files';

let booted = false;

async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  terminals.setWindowsBuild(window.mc.windowsBuild);
  window.mc.on('state:changed', (snapshot) => {
    const previous = getS().projects.flatMap((p) => p.tabs.flatMap((t) => t.cells));
    useStore.getState().sync(snapshot);
    for (const cell of previous) if (!findCell(getS(), cell.id)) releaseCellTerminal(cell.id);
  });
  window.mc.on('automation:start-cells', (ids) => ids.forEach(ensureStarted));
  const [snapshot, alive, mcpInfo] = await Promise.all([window.mc.loadSnapshot(), window.mc.aliveCells(), window.mc.getMcpInfo()]);
  setAliveAtStart(alive);
  useStore.getState().init(snapshot);
  setUi({ mcpInfo });
  const state = getS();

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

  window.mc.on('cell:restarted', (cellId) => { terminals.prepareSpawn(cellId); terminals.syncSize(cellId); });
  window.mc.on('cell:hook', (cellId, event) => terminals.hook(cellId, event));
  window.mc.on('cell:session', (cellId, session) => update((s) => updateCell(s, cellId, { session })));
  window.mc.on('cell:spawnError', (cellId, message) => setUi((ui) => ({ cellErrors: { ...ui.cellErrors, [cellId]: message } })));
  window.mc.on('focus-cell', (cellId) => focusCell(cellId));
  window.mc.on('ptyhost:crashed', () => {
    toast(tr("Proces terminali się zrestartował, wznawiam rozmowy"), 'error');
    resetStarted();
  });

  terminals.onStatus((cellId, status) => {
    window.mc.reportCellStatus(cellId, status);
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
  // Restore background cells with unfinished assigned work, without changing the user's selection.
  for (const task of state.automation.tasks) {
    if (!['completed', 'cancelled'].includes(task.status)) ensureStarted(task.cellId);
  }
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
    body: tr('{name} czeka na Ciebie', { name: profile.name }),
    cellId,
  });
}

export function App() {
  const { language } = useI18n();
  const selectedFile = useFileStore((st) => st.activeFileId);
  const documents = useFileStore((st) => st.documents);
  const projectId = useStore((st) => st.s.activeProjectId);
  const fileOpen = documents.some((doc) => doc.id === selectedFile && doc.projectId === projectId);
  const ready = useStore((st) => st.ready);
  const automationOpen = useStore((st) => st.ui.automationOpen);
  const languageChosen = useStore((st) => st.s.settings.language !== null);
  const snippetsOpen = useStore((st) => st.s.snippetsOpen);
  const collapsed = useStore((st) => st.s.sidebarCollapsed);
  const sidebarWidth = useStore((st) => st.s.sidebarWidth);
  const snippetsWidth = useStore((st) => st.s.snippetsWidth);
  const body = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(window.innerWidth);
  const [live, setLive] = useState<Partial<Record<Panel, number>>>({});
  useEffect(() => void boot(), []);
  useEffect(() => {
    if (!ready) return;
    const refresh = () => void window.mc.getMcpInfo().then((mcpInfo) => setUi({ mcpInfo })).catch(() => {});
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [ready]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.platform = window.mc.platform;
  }, [language]);
  useLayoutEffect(() => {
    if (!ready || !body.current) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(body.current);
    return () => observer.disconnect();
  }, [ready, languageChosen]);
  useShortcuts();
  if (!ready) return <div className="app" />;
  if (!languageChosen) return <LanguageSetup />;
  const widths = fitPanelWidths(available, live.sidebar ?? sidebarWidth, live.snippets ?? snippetsWidth, collapsed, snippetsOpen);
  const resizeProps = (panel: Panel) => ({
    panel,
    width: widths[panel],
    maxWidth: available - MIN_WORKSPACE_WIDTH - widths[panel === 'sidebar' ? 'snippets' : 'sidebar'],
    onResize: (width: number) => setLive((current) => ({ ...current, [panel]: width })),
    onFinish: (width: number | null) => {
      if (width !== null) update((s) => ({ ...s, [panel === 'sidebar' ? 'sidebarWidth' : 'snippetsWidth']: width }));
      setLive((current) => { const next = { ...current }; delete next[panel]; return next; });
    },
  });
  return (
    <div className="app" style={{ '--sidebar-width': `${widths.sidebar}px`, '--snippets-width': `${widths.snippets}px` } as CSSProperties}>
      <TitleBar />
      <div className="app-body" ref={body}>
        <Sidebar resize={resizeProps('sidebar')} />
        <div className="main">
          <WorkspaceTabs />
          <div className="workspace-content">
            <div className="terminal-workspace" style={{ display: fileOpen ? 'none' : 'flex' }}><GridView /></div>
            {fileOpen && <FileEditor />}
          </div>
          {automationOpen && <AutomationPanel />}
        </div>
        {snippetsOpen && <SnippetPanel resize={resizeProps('snippets')} />}
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

