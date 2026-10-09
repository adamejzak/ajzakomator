import { describe, expect, it } from 'vitest';
import { fitPanelWidths, normalizePanelWidth, PANEL_LIMITS } from '../src/shared/panels';
import { defaultState, normalizeState } from '../src/shared/state';

describe('side panel widths', () => {
  it('loads older state with default widths and bounds invalid stored preferences', () => {
    const { sidebarWidth: _left, snippetsWidth: _right, ...old } = defaultState();
    expect(normalizeState(old)).toMatchObject({ sidebarWidth: 228, snippetsWidth: 280 });
    expect(normalizeState({ ...old, sidebarWidth: -10, snippetsWidth: 900 })).toMatchObject({ sidebarWidth: 200, snippetsWidth: 520 });
    expect(normalizePanelWidth(NaN, 'sidebar')).toBe(PANEL_LIMITS.sidebar.default);
    expect(normalizePanelWidth('300', 'snippets')).toBe(PANEL_LIMITS.snippets.default);
  });

  it('preserves both preferences in a large window', () => {
    expect(fitPanelWidths(1600, 400, 500, false, true)).toEqual({ sidebar: 400, snippets: 500 });
  });

  it('keeps the workspace usable when both panels are wide', () => {
    const widths = fitPanelWidths(800, 480, 520, false, true);
    expect(widths.sidebar).toBeGreaterThanOrEqual(200);
    expect(widths.snippets).toBeGreaterThanOrEqual(220);
    expect(800 - widths.sidebar - widths.snippets).toBeGreaterThanOrEqual(320);
    expect(fitPanelWidths(1600, 480, 520, false, true)).toEqual({ sidebar: 480, snippets: 520 });
  });

  it('accounts for hidden snippets and the collapsed project rail', () => {
    expect(fitPanelWidths(800, 480, 520, true, true)).toEqual({ sidebar: 48, snippets: 432 });
    expect(fitPanelWidths(800, 480, 520, false, false)).toEqual({ sidebar: 480, snippets: 0 });
  });

  it('does not lose a workspace pixel when both fitted widths round up', () => {
    const widths = fitPanelWidths(801, 260, 280, false, true);
    expect(801 - widths.sidebar - widths.snippets).toBeGreaterThanOrEqual(320);
  });
});
