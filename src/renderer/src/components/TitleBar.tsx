import { keyLabel } from '../platform';
import { useI18n } from '../i18n';
import { useState, type CSSProperties } from 'react';
import { describeLayout } from '../../../shared/layout';
import { activeProject, renameTab, PROJECT_COLORS } from '../../../shared/state';
import { aggregate } from '../../../shared/status';
import { addAgent, closeTab, selectTab } from '../actions';
import { setUi, update, useStore } from '../store';
import { openMenu, openMenuAt } from './ContextMenu';
import { IChevron, IPlusBold, IX, IFile, TGrid, THistory, TSettings, TSidebar, TSnippet } from './icons';
import { StatusBadges } from './StatusBadges';
import { UpdateBadge } from './UpdateBadge';
import { Brand } from './Brand';
import { activateFile, closeFile, useFileStore } from '../files';

export function TitleBar() {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const statuses = useStore((st) => st.ui.statuses);
  const automationOpen = useStore((st) => st.ui.automationOpen);
  const pendingTasks = s.automation.tasks.filter((t) => !['completed', 'cancelled'].includes(t.status)).length;
  const project = activeProject(s);
  return (
    <div className="titlebar">
      <Brand collapsed={s.sidebarCollapsed} />
      <div className="spacer" />
      {project && <span className="project-path" title={project.path}>{project.path}</span>}
      <UpdateBadge />
      <div className="row no-drag" style={{ gap: 2 }}>
        <button className={`tb-btn team-toggle ${automationOpen ? 'on' : ''}`} title={tr('Zadania i wiadomości agentów')} onClick={() => setUi({ automationOpen: !automationOpen })}>
          AI{pendingTasks > 0 && <span className="team-count">{pendingTasks}</span>}
        </button>
        {project && <button className="tb-btn" title={tr("Historia czatów i gridów") + keyLabel(" (Ctrl+Shift+H)")} onClick={() => setUi({ modal: { kind: 'history', projectId: project.id } })}><THistory /></button>}
        <button className={`tb-btn ${s.snippetsOpen ? 'on' : ''}`} title={tr("Snippety") + keyLabel(" (Ctrl+Shift+B)")} onClick={() => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen }))}><TSnippet /></button>
        <button className={`tb-btn ${!s.sidebarCollapsed ? 'on' : ''}`} title={tr("Panel projektów") + keyLabel(" (Ctrl+Shift+E)")} onClick={() => update((st) => ({ ...st, sidebarCollapsed: !st.sidebarCollapsed }))}><TSidebar /></button>
        <button className="tb-btn" title={tr("Ustawienia")} onClick={() => setUi({ modal: { kind: 'settings' } })}><TSettings /></button>
      </div>
    </div>
  );
}

export function WorkspaceTabs() {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const statuses = useStore((st) => st.ui.statuses);
  const project = activeProject(s);
  const documents = useFileStore((st) => st.documents);
  const selectedFile = useFileStore((st) => st.activeFileId);
  const activeFileId = documents.some((doc) => doc.id === selectedFile && doc.projectId === project?.id) ? selectedFile : null;
  const [editing, setEditing] = useState<string | null>(null);

  const agentMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: tr("Dodaj komórkę do siatki") },
      ...s.profiles.map((p) => ({ label: p.name, onClick: () => void addAgent(p.id), hint: p.id === s.settings.lastProfileId ? keyLabel("Ctrl+Shift+N") : undefined })),
      { sep: true as const },
      { header: tr("W osobnym git worktree") },
      ...s.profiles.filter((p) => p.cli !== 'shell').map((p) => ({ label: `${p.name} + worktree`, onClick: () => void addAgent(p.id, true) })),
    ]);

  return <div className="workspace-tabs" aria-label={tr('Gridy i pliki')}>
      {project && (
        <div className="tabs no-drag">
          {project.tabs.map((t) => {
            const counts = aggregate(t.cells.map((c) => statuses[c.id] ?? 'idle'));
            return (
              <div
                key={t.id}
                className={`tab grid-tab ${!activeFileId && t.id === project.activeTabId ? 'active' : ''}`}
                style={t.color ? { '--tab-color': t.color } as CSSProperties : undefined}
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
                <StatusBadges counts={counts} compact />
                <span className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(project.id, t.id)}><IX /></span>
              </div>
            );
          })}
          {documents.filter((doc) => doc.projectId === project.id).map((doc) => (
            <div key={doc.id} className={`tab file-tab ${activeFileId === doc.id ? 'active' : ''}`} title={doc.relativePath}
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
        </div>
      )}
  </div>;
}
