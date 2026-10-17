import { describe, expect, it } from 'vitest';
import { areaRects, layoutForCount, layoutFromRows } from '../src/shared/layout';
import { defaultState, isUsableLayout, normalizeState, repairTab } from '../src/shared/state';

const cell = (id: string) => ({ id, profileId: 'claude' });
const saved = (tabs: unknown[], archive: unknown[] = []) => ({
  ...defaultState(),
  projects: [{ id: 'p', name: 'P', path: 'C:/p', tabs, archive, activeTabId: 't1' }],
});

describe('layout repair on load', () => {
  it('rebuilds a layout whose areas are missing, empty or of the wrong count', () => {
    for (const layout of [undefined, null, {}, { cols: 1, rows: 1, areas: [] }, { cols: 2, rows: 1, areas: 'x' }, layoutForCount(3)]) {
      const state = normalizeState(saved([{ id: 't1', name: 'a', cells: [cell('a'), cell('b')], layout }]))!;
      const tab = state.projects[0].tabs[0];
      expect(tab.layout).toEqual(layoutForCount(2));
      expect(areaRects(tab.layout)).toHaveLength(2);
    }
  });

  it('keeps a good layout, also a row-based one and a resized one', () => {
    const rows = { ...layoutFromRows([3, 2]), rowSizes: [2, 1] };
    const state = normalizeState(saved([{ id: 't1', name: 'a', cells: ['a', 'b', 'c', 'd', 'e'].map(cell), layout: rows }]))!;
    expect(state.projects[0].tabs[0].layout).toEqual(rows);
  });

  it('rejects areas outside the grid and size fields of the wrong type', () => {
    expect(isUsableLayout({ cols: 1, rows: 1, areas: [{ col: 1, row: 0, colSpan: 1, rowSpan: 1 }] }, 1)).toBe(false);
    expect(isUsableLayout({ ...layoutForCount(2), rowSizes: 'wide' }, 2)).toBe(false);
    expect(isUsableLayout({ ...layoutForCount(2), rowColSizes: [null, [1, 'x']] }, 2)).toBe(false);
    expect(isUsableLayout({ ...layoutForCount(2), mode: 'diagonal' }, 2)).toBe(false);
    expect(isUsableLayout(layoutForCount(4), 4)).toBe(true);
  });

  it('drops broken cells and tabs without cells, keeping every other tab and project', () => {
    const state = normalizeState({
      ...saved([
        { id: 't1', name: 'ok', cells: [cell('a')], layout: layoutForCount(1) },
        { id: 't2', name: 'no cells array' },
        { id: 't3', name: 'bad cells', cells: [null, { id: 5 }, cell('c')], layout: layoutForCount(3) },
        'not a tab',
      ], [{ id: 'old', name: 'gone', closedAt: 1, cells: [] }, { id: 'old2', name: 'kept', closedAt: 2, cells: [cell('z')] }]),
    })!;
    const project = state.projects[0];
    expect(project.tabs.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(project.tabs[1].cells.map((c) => c.id)).toEqual(['c']);
    expect(project.tabs[1].layout).toEqual(layoutForCount(1));
    expect(project.archive.map((t) => t.id)).toEqual(['old2']);
  });

  it('drops a project without an id or path instead of rejecting the whole file', () => {
    const raw = saved([{ id: 't1', name: 'ok', cells: [cell('a')], layout: layoutForCount(1) }]);
    const state = normalizeState({ ...raw, projects: [...raw.projects, { name: 'broken' }, null] })!;
    expect(state.projects.map((p) => p.id)).toEqual(['p']);
  });

  it('caps a tab at the cell limit and names a nameless tab', () => {
    const tab = repairTab({ id: 't', cells: Array.from({ length: 25 }, (_, i) => cell(`c${i}`)) })!;
    expect(tab.cells).toHaveLength(20);
    expect(tab.name).toBe('');
    expect(tab.layout.areas).toHaveLength(20);
    expect(repairTab({ cells: [cell('a')] })).toBeNull();
  });
});
