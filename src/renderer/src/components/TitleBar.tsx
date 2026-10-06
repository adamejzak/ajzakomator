import { useState } from 'react';
import { describeLayout } from '../../../shared/layout';
import { activeProject, renameTab } from '../../../shared/state';
import { aggregate } from '../../../shared/status';
import { addAgent, closeTab, selectTab } from '../actions';
import { setUi, update, useStore } from '../store';
import { openMenu, openMenuAt } from './ContextMenu';
import { IGrid, IHistory, IPlus, ISettings, ISidebar, ISnippet, IX, Logo } from './icons';
import { StatusBadges } from './StatusBadges';

export function TitleBar() {
  const s = useStore((st) => st.s);
  const statuses = useStore((st) => st.ui.statuses);
  const project = activeProject(s);
  const [editing, setEditing] = useState<string | null>(null);

  const agentMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: 'Dodaj komórkę do siatki' },
      ...s.profiles.map((p) => ({ label: p.name, onClick: () => void addAgent(p.id), hint: p.id === s.settings.lastProfileId ? 'Ctrl+Shift+N' : undefined })),
      { sep: true as const },
      { header: 'W osobnym git worktree' },
      ...s.profiles.filter((p) => p.cli !== 'shell').map((p) => ({ label: `${p.name} + worktree`, onClick: () => void addAgent(p.id, true) })),
    ]);

  return (
    <div className="titlebar">
      <div className={`brand ${s.sidebarCollapsed ? 'collapsed' : ''}`}>
        <span className="brand-mark"><Logo size={20} /></span>
        {!s.sidebarCollapsed && <span className="brand-name" data-text="ajzakomator">ajzakomator</span>}
      </div>
      {project && (
        <div className="tabs no-drag">
          {project.tabs.map((t) => {
            const counts = aggregate(t.cells.map((c) => statuses[c.id] ?? 'idle'));
            return (
              <div
                key={t.id}
                className={`tab ${t.id === project.activeTabId ? 'active' : ''}`}
                onMouseDown={(e) => e.button === 0 && selectTab(project.id, t)}
                onAuxClick={(e) => e.button === 1 && closeTab(project.id, t.id)}
                onDoubleClick={() => setEditing(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e.clientX, e.clientY, [
                    { label: 'Zmień nazwę', onClick: () => setEditing(t.id) },
                    { label: 'Nowy grid…', onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
                    { sep: true },
                    { label: 'Zamknij (do historii)', danger: true, onClick: () => closeTab(project.id, t.id), hint: 'Ctrl+Shift+W' },
                  ]);
                }}
                title="Dwuklik lub prawy klik: zmień nazwę · środkowy przycisk: zamknij"
              >
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
                <StatusBadges counts={counts} compact />
                <span className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(project.id, t.id)}><IX /></span>
              </div>
            );
          })}
          <button className="btn ghost icon" title="Nowy grid (Ctrl+Shift+G)" onClick={() => setUi({ modal: { kind: 'grid', projectId: project.id } })}><IGrid /></button>
          <button className="btn ghost small" title="Dodaj agenta do siatki" onClick={(e) => agentMenu(e.currentTarget)}><IPlus /> agent</button>
        </div>
      )}
      <div className="spacer" />
      {project && <span className="project-path" title={project.path}>{project.path}</span>}
      <div className="row no-drag" style={{ gap: 2 }}>
        {project && <button className="btn ghost icon" title="Historia (Ctrl+Shift+H)" onClick={() => setUi({ modal: { kind: 'history', projectId: project.id } })}><IHistory /></button>}
        <button className="btn ghost icon" title="Snippety (Ctrl+Shift+B)" onClick={() => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen }))}><ISnippet /></button>
        <button className="btn ghost icon" title="Panel projektów (Ctrl+Shift+E)" onClick={() => update((st) => ({ ...st, sidebarCollapsed: !st.sidebarCollapsed }))}><ISidebar /></button>
        <button className="btn ghost icon" title="Ustawienia" onClick={() => setUi({ modal: { kind: 'settings' } })}><ISettings /></button>
      </div>
    </div>
  );
}
