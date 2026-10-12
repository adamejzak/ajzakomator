import { keyLabel } from '../platform';
import { useI18n } from '../i18n';
import { useState, type CSSProperties, type DragEvent } from 'react';
import { workspaceOrder, reorderWorkspace } from '../../../shared/workspaceOrder';
import { describeLayout } from '../../../shared/layout';
import { activeProject, renameTab, PROJECT_COLORS } from '../../../shared/state';
import { aggregate } from '../../../shared/status';
import { addAgent, closeTab, selectTab } from '../actions';
import { setUi, update, useStore } from '../store';
import { profileOptionLabel } from '../cliUi';
import { openMenu, openMenuAt } from './ContextMenu';
import { IChevron, IPlusBold, ISearch, IX, IFile, TGrid, THistory, TSettings, TSidebar, TSnippet } from './icons';
import { StatusBadges } from './StatusBadges';
import { Brand } from './Brand';
import { activateFile, closeFile, useFileStore } from '../files';

export function TitleBar() {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const automationOpen = useStore((st) => st.ui.automationOpen);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  const pendingTasks = s.automation.tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length;
  const project = activeProject(s);
  return (
    <div className="titlebar">
      <Brand collapsed={s.sidebarCollapsed} />
      <div className="spacer" />
      <div className="row no-drag" style={{ gap: 2 }}>
        <button className="tb-btn" title={tr("Szukaj wszędzie") + keyLabel(" (Ctrl+K)")} aria-label={tr("Szukaj wszędzie")} onClick={() => setUi({ palette: true })}><ISearch /></button>
        <button className={`tb-btn team-toggle ${automationOpen ? 'on' : ''}`} title={tr('Zadania i wiadomości agentów')} onClick={() => setUi({ automationOpen: !automationOpen })}>
          AI{pendingTasks > 0 && <span className="team-count">{pendingTasks}</span>}
        </button>
        {project && <button className="tb-btn" title={tr("Historia czatów i gridów") + keyLabel(" (Ctrl+Shift+H)")} onClick={() => setUi({ modal: { kind: 'history', projectId: project.id } })}><THistory /></button>}
        <button className={`tb-btn ${s.snippetsOpen ? 'on' : ''}`} title={tr("Snippety") + keyLabel(" (Ctrl+Shift+B)")} onClick={() => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen }))}><TSnippet /></button>
        <button className={`tb-btn ${!s.sidebarCollapsed ? 'on' : ''}`} title={tr("Panel projektów") + keyLabel(" (Ctrl+Shift+E)")} onClick={() => update((st) => ({ ...st, sidebarCollapsed: !st.sidebarCollapsed }))}><TSidebar /></button>
        <button className={`tb-btn ${settingsActive ? 'on' : ''}`} title={tr("Ustawienia")} aria-label={tr("Ustawienia")} onClick={() => setUi({ settingsTabOpen: true, settingsActive: true })}><TSettings /></button>
      </div>
    </div>
  );
}

export function WorkspaceTabs() {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const statuses = useStore((st) => st.ui.statuses);
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const project = activeProject(s);
  const documents = useFileStore((st) => st.documents);
  const selectedFile = useFileStore((st) => st.activeFileId);
  const activeFileId = documents.some((doc) => doc.id === selectedFile && doc.projectId === project?.id) ? selectedFile : null;
  const settingsTabOpen = useStore((st) => st.ui.settingsTabOpen);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  const [editing, setEditing] = useState<string | null>(null);
  const [orders, setOrders] = useState<Record<string, string[]>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('mc-workspace-order-v1') ?? '{}');
      return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((id) => typeof id === 'string')));
    } catch { return {}; }
  });
  const [drag, setDrag] = useState<{ id: string; projectId: string } | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const projectKey = project?.id ?? 'no-project';
  const order = workspaceOrder(orders[projectKey] ?? [], [
    ...(settingsTabOpen ? ['settings'] : []),
    ...(project?.tabs.map((t) => `grid:${t.id}`) ?? []),
    ...documents.filter((doc) => doc.projectId === project?.id).map((doc) => `file:${doc.id}`),
  ]);
  const endDrag = () => { setDrag(null); setDrop(null); };
  const dragProps = (id: string) => ({
    draggable: editing !== id.slice(5),
    'data-workspace-id': id,
    'data-dragging': drag?.id === id ? '' : undefined,
    'data-drop': drop?.id === id ? (drop.after ? 'after' : 'before') : undefined,
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('input, .x')) { e.preventDefault(); return; }
      e.dataTransfer.setData('application/x-ajzakomator-workspace-tab', id);
      e.dataTransfer.effectAllowed = 'move';
      setDrag({ id, projectId: projectKey });
    },
    onDragEnd: endDrag,
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!drag || drag.projectId !== projectKey || drag.id === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const bounds = e.currentTarget.getBoundingClientRect();
      setDrop({ id, after: e.clientX > bounds.left + bounds.width / 2 });
      const strip = e.currentTarget.parentElement!;
      const viewport = strip.getBoundingClientRect();
      if (e.clientX < viewport.left + 32) strip.scrollLeft -= 20;
      if (e.clientX > viewport.right - 32) strip.scrollLeft += 20;
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!drag || drag.projectId !== projectKey) return;
      e.preventDefault(); e.stopPropagation();
      const bounds = e.currentTarget.getBoundingClientRect();
      const next = reorderWorkspace(order, drag.id, id, e.clientX > bounds.left + bounds.width / 2);
      const saved = { ...orders, [projectKey]: next };
      setOrders(saved);
      try { localStorage.setItem('mc-workspace-order-v1', JSON.stringify(saved)); } catch { /* Current session order is retained. */ }
      if (project) update((st) => ({ ...st, projects: st.projects.map((p) => p.id === project.id
        ? { ...p, tabs: [...p.tabs].sort((a, b) => next.indexOf(`grid:${a.id}`) - next.indexOf(`grid:${b.id}`)) } : p) }));
      endDrag();
    },
  });

  const agentMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: tr("Dodaj komórkę do siatki") },
      ...s.profiles.map((p) => ({ label: profileOptionLabel(p, cliStatus, tr), onClick: () => void addAgent(p.id), hint: p.id === s.settings.lastProfileId ? keyLabel("Ctrl+Shift+N") : undefined })),
      { sep: true as const },
      { header: tr("W osobnym git worktree") },
      ...s.profiles.filter((p) => p.cli !== 'shell').map((p) => ({ label: `${profileOptionLabel(p, cliStatus, tr)} + worktree`, onClick: () => void addAgent(p.id, true) })),
    ]);

  return <div className="workspace-tabs" aria-label={tr('Gridy i pliki')}>
    <div className="tabs no-drag">
      {settingsTabOpen && <div {...dragProps('settings')} style={{ order: order.indexOf('settings') }} className={`tab settings-tab ${settingsActive ? 'active' : ''}`} onClick={() => setUi({ settingsActive: true })} onAuxClick={(e) => { if (e.button === 1) setUi({ settingsTabOpen: false, settingsActive: false }); }}>
        <span className="tab-type-icon"><TSettings /></span><span className="label">{tr('Ustawienia')}</span>
        <button className="x" aria-label={tr('Zamknij')} onClick={(e) => { e.stopPropagation(); setUi({ settingsTabOpen: false, settingsActive: false }); }}><IX /></button>
      </div>}
      {project && (
        <>
          {project.tabs.map((t) => {
            const counts = aggregate(t.cells.map((c) => statuses[c.id] ?? 'idle'));
            return (
              <div
                key={t.id}
                {...dragProps(`grid:${t.id}`)}
                className={`tab grid-tab ${!settingsActive && !activeFileId && t.id === project.activeTabId ? 'active' : ''}`}
                style={{ order: order.indexOf(`grid:${t.id}`), ...(t.color ? { '--tab-color': t.color } : {}) } as CSSProperties}
                onMouseDown={(e) => e.button === 0 && selectTab(project.id, t)}
                onAuxClick={(e) => e.button === 1 && closeTab(project.id, t.id)}
                onDoubleClick={() => setEditing(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, [
                    { label: tr("Zmień nazwę"), onClick: () => setEditing(t.id) },
                    { header: tr('Kolor') },
                    { colors: PROJECT_COLORS, onPick: (color) => update((st) => ({ ...st, projects: st.projects.map((p) => p.id === project.id ? { ...p, tabs: p.tabs.map((tab) => tab.id === t.id ? { ...tab, color } : tab) } : p) })) },
                    ...(t.color ? [{ label: tr('Usuń kolor'), onClick: () => update((st) => ({ ...st, projects: st.projects.map((p) => p.id === project.id ? { ...p, tabs: p.tabs.map((tab) => tab.id === t.id ? { ...tab, color: undefined } : tab) } : p) })) }] : []),
                    { label: tr("Nowy grid") + '…', onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
                    { sep: true },
                    { label: tr("Zamknij (do historii)"), danger: true, onClick: () => closeTab(project.id, t.id), hint: keyLabel("Ctrl+Shift+W") },
                  ]);
                }}
                title={tr("Dwuklik lub prawy klik: zmień nazwę · środkowy przycisk: zamknij")}
              >
                <span className="tab-type-icon" aria-hidden="true"><TGrid /></span>
                {editing === t.id ? (
                  <input
                    autoFocus
                    defaultValue={t.name}
                    onBlur={(e) => {
                      update((st) => renameTab(st, project.id, t.id, e.target.value.trim() || t.name));
                      setEditing(null);
                    }}
                    onFocus={(e) => e.target.select()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                ) : (
                  <span className="label">{t.name}</span>
                )}
                <span className="size">{describeLayout(t.layout)}</span>
                <StatusBadges counts={counts} />
                <span className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(project.id, t.id)}><IX /></span>
              </div>
            );
          })}
          {documents.filter((doc) => doc.projectId === project.id).map((doc) => (
            <div key={doc.id} {...dragProps(`file:${doc.id}`)} style={{ order: order.indexOf(`file:${doc.id}`) }} className={`tab file-tab ${!settingsActive && activeFileId === doc.id ? 'active' : ''}`} title={doc.relativePath}
              onClick={() => activateFile(doc.id)} onAuxClick={(e) => { if (e.button === 1) void closeFile(doc.id); }}>
              <span className="tab-type-icon" aria-hidden="true"><IFile /></span><span className="label">{doc.name}</span>
              {doc.text !== doc.savedText && <span className="file-dirty" aria-label={tr('Niezapisane zmiany')}>●</span>}
              <button className="x" aria-label={tr('Zamknij')} onClick={(e) => { e.stopPropagation(); void closeFile(doc.id); }}><IX /></button>
            </div>
          ))}
          <button className="tb-btn" title={tr("Nowy grid") + keyLabel(" (Ctrl+Shift+G)")} onClick={() => setUi({ modal: { kind: 'grid', projectId: project.id } })}><TGrid /></button>
          <button className="tb-add" title={tr("Dodaj agenta do siatki") + keyLabel(" (Ctrl+Shift+N)")} onClick={(e) => agentMenu(e.currentTarget)}>
            <IPlusBold />  {tr("Dodaj")} <IChevron />
          </button>
        </>
      )}
    </div>
  </div>;
}
