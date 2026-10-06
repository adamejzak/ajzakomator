import { useState } from 'react';
import { moveProject, PROJECT_COLORS, updateProject } from '../../../shared/state';
import { aggregate } from '../../../shared/status';
import type { Project } from '../../../shared/types';
import { createProject, relocateProject, removeProject, switchProject } from '../actions';
import { askText, setUi, update, useStore } from '../store';
import { openMenu } from './ContextMenu';
import { IFolder, IHistory, IPlus, ISearch } from './icons';
import { StatusBadges } from './StatusBadges';

export function ProjectIconView({ project }: { project: Project }) {
  const icon = project.icon;
  if (icon?.kind === 'image') return <span className="picon"><img src={icon.dataUrl} alt="" /></span>;
  if (icon?.kind === 'emoji') return <span className="picon" style={{ background: project.color + '33' }}>{icon.value}</span>;
  return <span className="picon swatch-only" style={{ background: project.color }} />;
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
              {active && !collapsed && (
                <>
                  {missing[p.id] && (
                    <div className="sub-item" onClick={() => void relocateProject(p.id)} style={{ color: '#f87171' }}>
                      <IFolder /> Folder nie istnieje — wskaż
                    </div>
                  )}
                  <div className="sub-item" onClick={() => setUi({ modal: { kind: 'history', projectId: p.id } })}>
                    <IHistory /> Historia
                    {p.archive.length > 0 && <span className="muted">({p.archive.length})</span>}
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
