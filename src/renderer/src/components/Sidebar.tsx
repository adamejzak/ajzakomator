import { useRef } from 'react';
import { useI18n } from '../i18n';
import { activeProject } from '../../../shared/state';
import { useGitProbe, useGitProbeSync } from '../git/gitProbe';
import { panelOpenable, railClick, railFocusTarget, resolvePanelId, visiblePanels } from '../../../shared/sidebarPanels';
import { SIDEBAR_PANELS } from '../panelRegistry';
import { setUi, update, useStore } from '../store';
import { PanelResizeHandle, type PanelResizeProps } from './PanelResizeHandle';
import { UsagePanel } from './UsagePanel';

/**
 * Left side: a rail of tiles (one per panel) and, next to it, the content of the selected panel with the resize handle.
 * Clicking the open panel's tile folds the content away; the rail stays (the collapsed state).
 */
export function Sidebar({ resize }: { resize: PanelResizeProps }) {
  const { tr } = useI18n();
  const collapsed = useStore((st) => st.s.sidebarCollapsed);
  const wanted = useStore((st) => st.ui.sidebarView);
  const hasProject = useStore((st) => !!activeProject(st.s));
  const projectId = useStore((st) => activeProject(st.s)?.id);
  const projectPath = useStore((st) => activeProject(st.s)?.path);
  useGitProbeSync(projectId, projectPath);
  const git = useGitProbe(projectId);
  const rail = useRef<HTMLDivElement>(null);
  const ctx = { hasProject, platform: window.mc.platform, git };
  const panels = visiblePanels(SIDEBAR_PANELS, ctx);
  const view = resolvePanelId(panels, wanted, ctx);
  const active = panels.find((panel) => panel.id === view) ?? panels[0];
  const Content = active.component;

  const choose = (id: string) => {
    const next = railClick({ collapsed, view }, id);
    if (next.collapsed !== collapsed) update((st) => ({ ...st, sidebarCollapsed: next.collapsed }));
    setUi({ sidebarView: next.view });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const tiles = Array.from(rail.current?.querySelectorAll<HTMLButtonElement>('.rail-tile') ?? []);
    const target = railFocusTarget(tiles.length, tiles.indexOf(document.activeElement as HTMLButtonElement), e.key);
    if (target === null) return;
    e.preventDefault();
    tiles[target]?.focus();
  };

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label={tr("Panel projektów")}>
      <div className="rail">
        <div ref={rail} className="rail-tiles" role="tablist" aria-orientation="vertical" aria-label={tr("Panele boczne")} onKeyDown={onKeyDown}>
          {panels.map((panel) => {
            const reason = panel.unavailableReason?.(ctx) ?? null;
            const shown = !collapsed && panel.id === active.id;
            const Icon = panel.icon;
            const label = tr(panel.label);
            return (
              <button
                key={panel.id}
                id={`${panel.id}-view`}
                type="button"
                role="tab"
                className={`rail-tile ${shown ? 'on' : ''}`}
                aria-selected={shown}
                aria-controls={shown ? `sidebar-${panel.id}` : undefined}
                aria-disabled={reason ? true : undefined}
                aria-label={label}
                tabIndex={panel.id === active.id ? 0 : -1}
                title={reason ? tr(reason) : shown ? `${label} · ${tr("Kliknij ponownie, aby zwinąć panel")}` : label}
                onClick={() => { if (panelOpenable(panel, ctx)) choose(panel.id); }}
              ><Icon /></button>
            );
          })}
        </div>
        {collapsed && <div className="rail-foot"><UsagePanel /></div>}
      </div>
      {!collapsed && (
        <div className="side-panel" id={`sidebar-${active.id}`} role="tabpanel" aria-labelledby={`${active.id}-view`}>
          <PanelResizeHandle {...resize} />
          <div className="side-panel-title">{tr(active.label)}</div>
          <Content resize={resize} />
          <UsagePanel />
        </div>
      )}
    </aside>
  );
}
