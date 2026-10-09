export const PANEL_LIMITS = {
  sidebar: { default: 228, min: 200, max: 480 },
  snippets: { default: 280, min: 220, max: 520 },
} as const;

export type Panel = keyof typeof PANEL_LIMITS;
export const COLLAPSED_SIDEBAR_WIDTH = 48;
export const MIN_WORKSPACE_WIDTH = 320;

export function normalizePanelWidth(value: unknown, panel: Panel): number {
  const limits = PANEL_LIMITS[panel];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(limits.min, Math.min(limits.max, value)))
    : limits.default;
}

/** Fit saved preferences to the window without overwriting them when the window shrinks. */
export function fitPanelWidths(
  available: number, sidebar: number, snippets: number, collapsed: boolean, snippetsOpen: boolean,
): { sidebar: number; snippets: number } {
  const left = collapsed ? COLLAPSED_SIDEBAR_WIDTH : normalizePanelWidth(sidebar, 'sidebar');
  const right = snippetsOpen ? normalizePanelWidth(snippets, 'snippets') : 0;
  const leftMin = collapsed ? COLLAPSED_SIDEBAR_WIDTH : PANEL_LIMITS.sidebar.min;
  const rightMin = snippetsOpen ? PANEL_LIMITS.snippets.min : 0;
  const budget = Math.max(leftMin + rightMin, available - MIN_WORKSPACE_WIDTH);
  const excess = Math.max(0, left + right - budget);
  const flexible = left + right - leftMin - rightMin;
  const ratio = flexible ? Math.min(1, excess / flexible) : 0;
  const fittedLeft = Math.round(left - (left - leftMin) * ratio);
  return {
    sidebar: fittedLeft,
    snippets: Math.min(Math.round(right - (right - rightMin) * ratio), Math.floor(budget - fittedLeft)),
  };
}
