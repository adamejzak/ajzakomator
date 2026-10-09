import { keyLabel } from '../platform';
import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import { describeLayout } from '../../../shared/layout';
import { activeProject, renameTab } from '../../../shared/state';
import { aggregate } from '../../../shared/status';
import { addAgent, closeTab, selectTab } from '../actions';
import { setUi, update, useStore } from '../store';
import { openMenu, openMenuAt } from './ContextMenu';
import { IChevron, IPlusBold, IX, Logo, TGrid, THistory, TSettings, TSidebar, TSnippet } from './icons';
import { StatusBadges } from './StatusBadges';
import { UpdateBadge } from './UpdateBadge';

// Each "moment" the white wordmark briefly takes one of these looks, then fades back to white.
const BRAND_THEMES = ['blue', 'red', 'green', 'amber', 'violet', 'sunset', 'ocean', 'aurora', 'rainbow', 'blue', 'green', 'red'];

function Brand({ collapsed }: { collapsed: boolean }) {
  const [fx, setFx] = useState<{ theme: string; on: boolean }>({ theme: 'blue', on: false });
  useEffect(() => {
    let timer: number;
    let last = '';
    const schedule = () => {
      timer = window.setTimeout(() => {
        let theme = last;
        while (theme === last) theme = BRAND_THEMES[Math.floor(Math.random() * BRAND_THEMES.length)];
        last = theme;
        setFx({ theme, on: true });
        timer = window.setTimeout(() => {
          setFx((f) => ({ ...f, on: false }));
          schedule();
        }, 2200 + Math.random() * 1600);
      }, 5000 + Math.random() * 7000);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className={`brand ${collapsed ? 'collapsed' : ''} ${fx.on ? 'fx' : ''} t-${fx.theme}`}>
      <span className="brand-mark"><Logo size={20} /></span>
      {!collapsed && (
        <span className="brand-name">
          <span className="bn-base">ajzakomator</span>
          <span className="bn-fx" aria-hidden>ajzakomator</span>
        </span>
      )}
    </div>
  );
}

export function TitleBar() {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const statuses = useStore((st) => st.ui.statuses);
  const project = activeProject(s);
  const [editing, setEditing] = useState<string | null>(null);

  const agentMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: tr("Dodaj komórkę do siatki") },
      ...s.profiles.map((p) => ({ label: p.name, onClick: () => void addAgent(p.id), hint: p.id === s.settings.lastProfileId ? keyLabel("Ctrl+Shift+N") : undefined })),
      { sep: true as const },
      { header: tr("W osobnym git worktree") },
      ...s.profiles.filter((p) => p.cli !== 'shell').map((p) => ({ label: `${p.name} + worktree`, onClick: () => void addAgent(p.id, true) })),
    ]);

  return (
    <div className="titlebar">
      <Brand collapsed={s.sidebarCollapsed} />
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
                    { label: tr("Zmień nazwę"), onClick: () => setEditing(t.id) },
                    { label: tr("Nowy grid") + '…', onClick: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) },
                    { sep: true },
                    { label: tr("Zamknij (do historii)"), danger: true, onClick: () => closeTab(project.id, t.id), hint: keyLabel("Ctrl+Shift+W") },
                  ]);
                }}
                title={tr("Dwuklik lub prawy klik: zmień nazwę · środkowy przycisk: zamknij")}
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
          <button className="tb-btn" title={tr("Nowy grid") + keyLabel(" (Ctrl+Shift+G)")} onClick={() => setUi({ modal: { kind: 'grid', projectId: project.id } })}><TGrid /></button>
          <button className="tb-add" title={tr("Dodaj agenta do siatki") + keyLabel(" (Ctrl+Shift+N)")} onClick={(e) => agentMenu(e.currentTarget)}>
            <IPlusBold />  {tr("Dodaj")} <IChevron />
          </button>
        </div>
      )}
      <div className="spacer" />
      {project && <span className="project-path" title={project.path}>{project.path}</span>}
      <UpdateBadge />
      <div className="row no-drag" style={{ gap: 2 }}>
        {project && <button className="tb-btn" title={tr("Historia czatów i gridów") + keyLabel(" (Ctrl+Shift+H)")} onClick={() => setUi({ modal: { kind: 'history', projectId: project.id } })}><THistory /></button>}
        <button className={`tb-btn ${s.snippetsOpen ? 'on' : ''}`} title={tr("Snippety") + keyLabel(" (Ctrl+Shift+B)")} onClick={() => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen }))}><TSnippet /></button>
        <button className={`tb-btn ${!s.sidebarCollapsed ? 'on' : ''}`} title={tr("Panel projektów") + keyLabel(" (Ctrl+Shift+E)")} onClick={() => update((st) => ({ ...st, sidebarCollapsed: !st.sidebarCollapsed }))}><TSidebar /></button>
        <button className="tb-btn" title={tr("Ustawienia")} onClick={() => setUi({ modal: { kind: 'settings' } })}><TSettings /></button>
      </div>
    </div>
  );
}
