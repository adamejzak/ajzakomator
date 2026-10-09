import { keyLabel } from '../platform';
import { useI18n } from '../i18n';
import { useState } from 'react';
import { activeProject, moveProject, PROJECT_COLORS, renameTab, updateProject, type DropEdge } from '../../../shared/state';
import { PANEL_LIMITS } from '../../../shared/panels';
import { aggregate, type CellStatus } from '../../../shared/status';
import { describeLayout } from '../../../shared/layout';
import type { Project } from '../../../shared/types';
import { closeTab, createProject, relocateProject, removeProject, selectTab, switchProject } from '../actions';
import { askText, setUi, update, useStore } from '../store';
import { openMenu } from './ContextMenu';
import { IFolder, IGrid, IGrip, IHistory, IPlus, ISearch } from './icons';
import { dropEdge, scrollDragList } from './listDrag';
import { StatusBadges } from './StatusBadges';
import { PanelResizeHandle, type PanelResizeProps } from './PanelResizeHandle';
import { ProjectExplorer } from './ProjectExplorer';
import { ProjectIconView } from './ProjectIcon';

const INACTIVE_TABS = 3;
const PROJECT_MIME = 'application/x-mc-project';

/** Open grids of a project: all for the active one, the last few for the others. */
function TabList({ project, active, statuses }: { project: Project; active: boolean; statuses: Record<string, CellStatus> }) {
  const { tr } = useI18n();
  const tabs = active ? project.tabs : project.tabs.slice(-INACTIVE_TABS);
  const hidden = project.tabs.length - tabs.length;
  if (!project.tabs.length) return null;
  return (
    <>
      {tabs.map((t) => {
        const counts = aggregate(t.cells.map((c) => statuses[c.id] ?? 'idle'));
        const dot = counts.waiting ? 'waiting' : counts.working ? 'working' : counts.exited ? 'exited' : '';
        const on = active && project.activeTabId === t.id;
        return (
          <div
            key={t.id}
            className={`sub-item tab-item ${on ? 'on' : ''}`}
            title={`${t.name} · ${describeLayout(t.layout)}`}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openMenu(e.clientX, e.clientY, [
                { header: t.name },
                { label: tr("Zmień nazwę gridu…"), onClick: async () => {
                  const name = await askText(tr("Nazwa gridu"), t.name);
                  if (name?.trim()) update((s) => renameTab(s, project.id, t.id, name.trim()));
                } },
                { label: tr("Nowy grid") + '…', onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
                { sep: true },
                { label: tr("Zamknij grid"), onClick: () => closeTab(project.id, t.id) },
              ]);
            }}
            onClick={() => {
              if (!active) switchProject(project.id);
              selectTab(project.id, t);
            }}
          >
            {dot ? <span className={`dot ${dot}`} /> : <IGrid />}
            <span className="tname">{t.name}</span>
            <StatusBadges counts={counts} compact />
            <span className="tsize">{describeLayout(t.layout)}</span>
          </div>
        );
      })}
      {hidden > 0 && (
        <div className="sub-item more" onClick={() => switchProject(project.id)}>{tr('+{count} więcej', { count: hidden })}</div>
      )}
    </>
  );
}

export function Sidebar({ resize }: { resize: PanelResizeProps }) {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const statuses = useStore((st) => st.ui.statuses);
  const missing = useStore((st) => st.ui.missingPaths);
  const collapsed = s.sidebarCollapsed;
  const view = useStore((st) => st.ui.sidebarView);
  const project = activeProject(s);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string | null; edge: DropEdge } | null>(null);
  const endDrag = () => { setDragId(null); setOver(null); };
  const openFiles = (p: Project) => {
    if (s.activeProjectId !== p.id) switchProject(p.id);
    update((st) => ({ ...st, sidebarCollapsed: false }));
    setUi({ sidebarView: 'files' });
  };

  const backgroundMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, .project, .sub-item')) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { header: tr("Panel projektów") },
      { label: tr("Dodaj projekt") + '…', onClick: () => void createProject() },
      ...(project ? [
        { label: tr("Nowy grid") + '…', onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
        { label: tr("Przeglądaj pliki projektu"), onClick: () => openFiles(project) },
      ] : []),
      { sep: true },
      { label: tr("Nowy snippet") + '…', onClick: () => {
        update((st) => ({ ...st, snippetsOpen: true }));
        setUi({ modal: { kind: 'snippet', snippetId: null } });
      } },
      { label: s.snippetsOpen ? tr("Ukryj snippety") : tr("Pokaż snippety"), hint: keyLabel("Ctrl+Shift+B"), onClick: () => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen })) },
      { sep: true },
      { label: tr("Przywróć szerokość panelu"), onClick: () => resize.onFinish(PANEL_LIMITS.sidebar.default) },
    ]);
  };

  const menu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    e.stopPropagation();
    const index = s.projects.findIndex((item) => item.id === p.id);
    openMenu(e.clientX, e.clientY, [
      { header: p.name },
      { label: tr("Edytuj projekt (nazwa, ikona)…"), onClick: () => setUi({ modal: { kind: 'project', projectId: p.id } }) },
      { label: tr("Zmień nazwę"), onClick: async () => {
        const name = await askText(tr("Nazwa projektu"), p.name);
        if (name?.trim()) update((st) => updateProject(st, p.id, { name: name.trim() }));
      } },
      { colors: PROJECT_COLORS, onPick: (color) => update((st) => updateProject(st, p.id, { color })) },
      ...(index > 0 ? [{ label: tr("Przesuń wyżej"), onClick: () => update((st) => moveProject(st, p.id, s.projects[index - 1].id, 'before')) }] : []),
      ...(index < s.projects.length - 1 ? [{ label: tr("Przesuń niżej"), onClick: () => update((st) => moveProject(st, p.id, s.projects[index + 1].id, 'after')) }] : []),
      { sep: true },
      { label: tr("Przeglądaj pliki projektu"), onClick: () => openFiles(p) },
      { label: tr("Otwórz folder"), onClick: () => window.mc.openPath(p.path) },
      { label: tr("Otwórz w Cursorze"), onClick: () => window.mc.openInEditor(p.path) },
      { label: tr("Historia"), onClick: () => setUi({ modal: { kind: 'history', projectId: p.id } }) },
      { label: tr("Zmień folder…"), onClick: () => void relocateProject(p.id) },
      { sep: true },
      { label: tr("Usuń z listy"), danger: true, onClick: () => void removeProject(p.id) },
    ]);
  };

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label={tr("Panel projektów")} onContextMenu={backgroundMenu}>
      {!collapsed && <PanelResizeHandle {...resize} />}
      <div className="side-section">
        {!collapsed && (
          <div className="sidebar-heading">
            <div className="sidebar-tabs" role="tablist" aria-label={tr("Widok panelu projektów")}>
              <button id="projects-view" role="tab" aria-selected={view === 'projects' || !project} aria-controls="sidebar-projects" className={view === 'projects' || !project ? 'on' : ''} onClick={() => setUi({ sidebarView: 'projects' })}>{tr("Projekty")}</button>
              <button id="files-view" role="tab" aria-selected={view === 'files' && !!project} aria-controls="sidebar-files" className={view === 'files' && project ? 'on' : ''} disabled={!project} title={project ? tr('Pliki projektu {name}', { name: project.name }) : tr("Najpierw dodaj projekt")} onClick={() => setUi({ sidebarView: 'files' })}>{tr("Pliki")}</button>
            </div>
            <button className="sq" title={tr("Dodaj projekt")} aria-label={tr("Dodaj projekt")} onClick={() => void createProject()}><IPlus /></button>
          </div>
        )}
      </div>
      {!collapsed && view === 'files' && project ? (
        <div id="sidebar-files" className="sidebar-content" role="tabpanel" aria-labelledby="files-view">
          <ProjectExplorer key={`${project.id}:${project.path}`} project={project} />
        </div>
      ) : (
      <div className="side-list" id="sidebar-projects" role="tabpanel" aria-labelledby={collapsed ? undefined : 'projects-view'}
        onDragOver={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(PROJECT_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          scrollDragList(e.currentTarget, e.clientY);
          if (!(e.target as HTMLElement).closest('.project-group')) setOver({ id: null, edge: 'after' });
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
        onDrop={(e) => {
          if (!dragId || !e.dataTransfer.types.includes(PROJECT_MIME)) return;
          e.preventDefault();
          update((st) => moveProject(st, dragId, null));
          endDrag();
        }}
      >
        {s.projects.map((p) => {
          const counts = aggregate(p.tabs.flatMap((t) => t.cells.map((c) => statuses[c.id] ?? 'idle')));
          const active = p.id === s.activeProjectId;
          return (
            <div key={p.id} data-project-id={p.id} className={`project-group ${dragId === p.id ? 'dragging' : ''} ${over?.id === p.id && dragId !== p.id ? `drop-${over.edge}` : ''}`}
              onDragOver={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(PROJECT_MIME)) return;
                e.preventDefault();
                const row = e.currentTarget.querySelector<HTMLElement>('.project')!;
                setOver({ id: p.id, edge: dropEdge(row, e.clientY) });
              }}
              onDrop={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(PROJECT_MIME)) return;
                e.preventDefault();
                e.stopPropagation();
                const row = e.currentTarget.querySelector<HTMLElement>('.project')!;
                update((st) => moveProject(st, dragId, p.id, dropEdge(row, e.clientY)));
                endDrag();
              }}
            >
              <div
                className={`project ${active ? 'active' : ''} ${missing[p.id] ? 'missing' : ''}`}
                title={`${missing[p.id] ? tr('Folder nie istnieje: {path}', { path: p.path }) : p.path}\n${tr('Przeciągnij, aby zmienić kolejność')}`}
                onClick={() => switchProject(p.id)}
                onDoubleClick={() => setUi({ modal: { kind: 'project', projectId: p.id } })}
                onContextMenu={(e) => menu(e, p)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(PROJECT_MIME, p.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDragId(p.id);
                }}
                onDragEnd={endDrag}
              >
                {!collapsed && <span className="list-drag-grip" title={tr("Przeciągnij projekt, aby zmienić kolejność")} aria-hidden="true"><IGrip /></span>}
                <button className="project-avatar" title={tr('Edytuj ikonę projektu {name}', { name: p.name })} aria-label={tr('Edytuj ikonę projektu {name}', { name: p.name })} onClick={(e) => {
                  e.stopPropagation();
                  setUi({ modal: { kind: 'project', projectId: p.id } });
                }} onDoubleClick={(e) => e.stopPropagation()} draggable={false}>
                  <ProjectIconView project={p} />
                </button>
                {!collapsed && <span className="name">{p.name}</span>}
                {!collapsed && <StatusBadges counts={counts} />}
              </div>
              {!collapsed && <TabList project={p} active={active} statuses={statuses} />}
              {active && !collapsed && (
                <>
                  {missing[p.id] && (
                    <div className="sub-item" onClick={() => void relocateProject(p.id)} style={{ color: '#f87171' }}>
                      <IFolder />  {tr("Folder nie istnieje, wskaż nowy")}
                    </div>
                  )}
                  <div className="sub-item" onClick={() => setUi({ modal: { kind: 'history', projectId: p.id } })}>
                    <IHistory />  {tr("Historia czatów i gridów")}
                  </div>
                </>
              )}
            </div>
          );
        })}
      {s.projects.length > 0 && <div className={`project-drop-space ${over?.id === null ? 'drop-end' : ''}`} aria-hidden="true" />}
      {!s.projects.length && !collapsed && (
        <div className="empty-state">
          <div className="es-icon"><IFolder /></div>
          <div className="es-title">{tr("Brak projektów")}</div>
          <div className="es-text">{tr("Projekt to folder, w którym będą pracować Twoi agenci.")}</div>
          <button className="btn white lg" onClick={() => void createProject()}><IPlus />  {tr("Nowy projekt")}</button>
        </div>
      )}
      </div>
      )}
      <div className="side-footer">
        {(s.projects.length > 0 || collapsed) && (
          <button className="btn" onClick={() => void createProject()} title={tr("Dodaj projekt")}><IFolder />{!collapsed && tr("Dodaj projekt")}</button>
        )}
        <button className="btn ghost" onClick={() => setUi({ palette: true })} title={tr("Szukaj wszędzie") + keyLabel("(Ctrl+K)")}>
          <ISearch />{!collapsed && <><span style={{ flex: 1, textAlign: 'left' }}>{tr("Szukaj…")}</span><span className="kbd">{keyLabel("Ctrl+K")}</span></>}
        </button>
      </div>
    </aside>
  );
}
