import { useState } from 'react';
import { moveProject, PROJECT_COLORS, updateProject } from '../../../shared/state';
import { aggregate, type CellStatus } from '../../../shared/status';
import { describeLayout } from '../../../shared/layout';
import type { Project } from '../../../shared/types';
import { createProject, relocateProject, removeProject, selectTab, switchProject } from '../actions';
import { askText, setUi, update, useStore } from '../store';
import { openMenu } from './ContextMenu';
import { IFolder, IGrid, IHistory, IPlus, ISearch } from './icons';
import { StatusBadges } from './StatusBadges';

export function ProjectIconView({ project, size = 'md' }: { project: Project; size?: 'md' | 'xl' }) {
  const icon = project.icon;
  const cls = `picon ${size}`;
  if (icon?.kind === 'image') return <span className={cls}><img src={icon.dataUrl} alt="" /></span>;
  if (icon?.kind === 'emoji') return <span className={cls} style={{ background: project.color + '2e' }}>{icon.value}</span>;
  // No icon: the project's initial on its color.
  return (
    <span className={`${cls} letter`} style={{ background: project.color + '2e', color: project.color }}>
      {project.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

const INACTIVE_TABS = 3;

/** Open grids of a project: all for the active one, the last few for the others. */
function TabList({ project, active, statuses }: { project: Project; active: boolean; statuses: Record<string, CellStatus> }) {
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
        <div className="sub-item more" onClick={() => switchProject(project.id)}>+{hidden} więcej</div>
      )}
    </>
  );
}

export function Sidebar() {
  const s = useStore((st) => st.s);
  const statuses = useStore((st) => st.ui.statuses);
  const missing = useStore((st) => st.ui.missingPaths);
  const collapsed = s.sidebarCollapsed;
  const [dragId, setDragId] = useState<string | null>(null);

  const menu = (e: React.MouseEvent, p: Project) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { header: p.name },
      { label: 'Edytuj projekt (nazwa, ikona)…', onClick: () => setUi({ modal: { kind: 'project', projectId: p.id } }) },
      { label: 'Zmień nazwę', onClick: async () => {
        const name = await askText('Nazwa projektu', p.name);
        if (name?.trim()) update((st) => updateProject(st, p.id, { name: name.trim() }));
      } },
      { colors: PROJECT_COLORS, onPick: (color) => update((st) => updateProject(st, p.id, { color })) },
      { sep: true },
      { label: 'Otwórz folder', onClick: () => window.mc.openPath(p.path) },
      { label: 'Otwórz w Cursorze', onClick: () => window.mc.openInEditor(p.path) },
      { label: 'Historia', onClick: () => setUi({ modal: { kind: 'history', projectId: p.id } }) },
      { label: 'Zmień folder…', onClick: () => void relocateProject(p.id) },
      { sep: true },
      { label: 'Usuń z listy', danger: true, onClick: () => void removeProject(p.id) },
    ]);
  };

  return (
    <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="side-section">
        {!collapsed && (
          <div className="side-title">
            <span>Projekty</span>
            <button className="sq" title="Dodaj projekt" onClick={() => void createProject()}><IPlus /></button>
          </div>
        )}
      </div>
      <div className="side-list" style={!s.projects.length ? { flex: 'none' } : undefined}>
        {s.projects.map((p) => {
          const counts = aggregate(p.tabs.flatMap((t) => t.cells.map((c) => statuses[c.id] ?? 'idle')));
          const active = p.id === s.activeProjectId;
          return (
            <div key={p.id}>
              <div
                className={`project ${active ? 'active' : ''} ${missing[p.id] ? 'missing' : ''}`}
                title={missing[p.id] ? `Folder nie istnieje: ${p.path}` : p.path}
                onClick={() => switchProject(p.id)}
                onDoubleClick={() => setUi({ modal: { kind: 'project', projectId: p.id } })}
                onContextMenu={(e) => menu(e, p)}
                draggable
                onDragStart={() => setDragId(p.id)}
                onDragOver={(e) => dragId && e.preventDefault()}
                onDrop={() => {
                  if (dragId && dragId !== p.id) update((st) => moveProject(st, dragId, st.projects.findIndex((x) => x.id === p.id)));
                  setDragId(null);
                }}
              >
                <ProjectIconView project={p} />
                {!collapsed && <span className="name">{p.name}</span>}
                {!collapsed && <StatusBadges counts={counts} />}
              </div>
              {!collapsed && <TabList project={p} active={active} statuses={statuses} />}
              {active && !collapsed && (
                <>
                  {missing[p.id] && (
                    <div className="sub-item" onClick={() => void relocateProject(p.id)} style={{ color: '#f87171' }}>
                      <IFolder /> Folder nie istnieje, wskaż nowy
                    </div>
                  )}
                  <div className="sub-item" onClick={() => setUi({ modal: { kind: 'history', projectId: p.id } })}>
                    <IHistory /> Historia czatów i gridów
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {!s.projects.length && !collapsed && (
        <div className="empty-state">
          <div className="es-icon"><IFolder /></div>
          <div className="es-title">Brak projektów</div>
          <div className="es-text">Projekt to folder, w którym będą pracować Twoi agenci.</div>
          <button className="btn white lg" onClick={() => void createProject()}><IPlus /> Nowy projekt</button>
        </div>
      )}
      <div className="side-footer">
        {(s.projects.length > 0 || collapsed) && (
          <button className="btn" onClick={() => void createProject()} title="Dodaj projekt"><IFolder />{!collapsed && 'Dodaj projekt'}</button>
        )}
        <button className="btn ghost" onClick={() => setUi({ palette: true })} title="Szukaj wszędzie (Ctrl+K)">
          <ISearch />{!collapsed && <><span style={{ flex: 1, textAlign: 'left' }}>Szukaj…</span><span className="kbd">Ctrl+K</span></>}
        </button>
      </div>
    </div>
  );
}
