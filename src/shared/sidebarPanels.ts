// Logic of the left panel rail (the tiles that switch panels). The registry itself, with icons and components, lives in
// the renderer (panelRegistry.ts); this file holds what can be tested without a DOM.
import type { GitProbe } from './git';
import type { MessageKey } from './i18n';
import type { AppPlatform } from './platform';

/** `git`: what a probe of the active project found (null: not known yet, which never blocks the tile). */
export interface PanelContext { hasProject: boolean; platform: AppPlatform; git?: GitProbe | null }

/** What the rail needs to know about a panel. */
export interface PanelDef {
  id: string;
  /** False hides the tile altogether (a panel that does not exist on this platform or is switched off). Default: shown. */
  available?: (ctx: PanelContext) => boolean;
  /** A reason (translation key) when the tile is shown but cannot be opened right now; null/absent: it can. */
  unavailableReason?: (ctx: PanelContext) => string | null;
}

export const DEFAULT_PANEL = 'projects';

/** The Git tile needs a project that is a git repository on a machine that has git. */
export function gitPanelReason(ctx: PanelContext): MessageKey | null {
  if (!ctx.hasProject) return 'Najpierw dodaj projekt';
  if (ctx.git === 'no-repo') return 'To nie jest repozytorium git';
  if (ctx.git === 'no-git') return 'Nie znaleziono gita. Zainstaluj Git (git-scm.com).';
  return null;
}

export function visiblePanels<T extends PanelDef>(defs: readonly T[], ctx: PanelContext): T[] {
  return defs.filter((def) => def.available?.(ctx) !== false);
}

export const panelOpenable = (def: PanelDef, ctx: PanelContext): boolean => !def.unavailableReason?.(ctx);

/**
 * The panel to show for a wanted id (a stored or older value, or one from a newer version): the wanted one when it exists,
 * is visible and can be opened, otherwise the default panel.
 */
export function resolvePanelId(defs: readonly PanelDef[], wanted: unknown, ctx: PanelContext): string {
  const found = typeof wanted === 'string' ? visiblePanels(defs, ctx).find((def) => def.id === wanted) : undefined;
  return found && panelOpenable(found, ctx) ? found.id : DEFAULT_PANEL;
}

export interface RailState { collapsed: boolean; view: string }

/** A click on a tile: open that panel; clicking the open panel's tile again folds the panel away (only the rail stays). */
export function railClick(state: RailState, clicked: string): RailState {
  if (!state.collapsed && state.view === clicked) return { collapsed: true, view: clicked };
  return { collapsed: false, view: clicked };
}

/** Roving focus along the rail: where the focus goes for an arrow / Home / End key (null: not a rail key). */
export function railFocusTarget(count: number, index: number, key: string): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
