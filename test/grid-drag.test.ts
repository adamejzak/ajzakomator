import { describe, expect, it } from 'vitest';
import { cellAtPoint, neighborSlot } from '../src/shared/gridDrag';
import { areaRects, layoutForCount, layoutFromRows, resizeDivider, dividers } from '../src/shared/layout';
import { addProject, addTab, defaultState, normalizeState, setTabLayout, swapCells } from '../src/shared/state';

function tabOf(layout = layoutForCount(4)) {
  let s = addProject(defaultState(), { name: 'p', path: 'D:\\p' });
  const p = s.projects[0];
  s = addTab(s, p.id, { layout, cells: layout.areas.map(() => ({ profileId: 'shell' })) });
  return { s, projectId: p.id, tab: s.projects[0].tabs[0] };
}

describe('swapCells', () => {
  it('swaps two cells inside a row and keeps the layout geometry untouched', () => {
    const { s, projectId, tab } = tabOf();
    const [a, b] = [tab.cells[0].id, tab.cells[1].id];
    const next = swapCells(s, projectId, tab.id, a, b).projects[0].tabs[0];
    expect(next.cells.map((c) => c.id)).toEqual([b, a, tab.cells[2].id, tab.cells[3].id]);
    expect(next.layout).toBe(tab.layout);
  });

  it('swaps across rows', () => {
    const { s, projectId, tab } = tabOf();
    const [a, d] = [tab.cells[0].id, tab.cells[3].id];
    const next = swapCells(s, projectId, tab.id, a, d).projects[0].tabs[0];
    expect(next.cells.map((c) => c.id)).toEqual([d, tab.cells[1].id, tab.cells[2].id, a]);
  });

  it('keeps cell objects (pty identity, name, session) and does nothing for the same or unknown ids', () => {
    const { s, projectId, tab } = tabOf();
    const next = swapCells(s, projectId, tab.id, tab.cells[1].id, tab.cells[2].id).projects[0].tabs[0];
    expect(next.cells[1]).toBe(tab.cells[2]);
    expect(next.cells[2]).toBe(tab.cells[1]);
    expect(swapCells(s, projectId, tab.id, tab.cells[0].id, tab.cells[0].id)).toBe(s);
    expect(swapCells(s, projectId, tab.id, tab.cells[0].id, 'nope')).toBe(s);
    expect(swapCells(s, projectId, 'no-tab', tab.cells[0].id, tab.cells[1].id)).toBe(s);
  });

  it('keeps per-row column sizes and row heights while cells change slots', () => {
    const { s, projectId, tab } = tabOf(layoutFromRows([3, 2]));
    const d = dividers(tab.layout).find((x) => x.axis === 'col')!;
    const sized = resizeDivider(tab.layout, d, 0.1);
    const s1 = setTabLayout(s, projectId, tab.id, sized);
    const before = areaRects(sized);
    const next = swapCells(s1, projectId, tab.id, tab.cells[0].id, tab.cells[4].id).projects[0].tabs[0];
    expect(next.layout).toBe(sized);
    expect(areaRects(next.layout)).toEqual(before);
    expect(next.cells[0].id).toBe(tab.cells[4].id);
  });

  it('survives a save/load round trip', () => {
    const { s, projectId, tab } = tabOf();
    const swapped = swapCells(s, projectId, tab.id, tab.cells[0].id, tab.cells[2].id);
    const loaded = normalizeState(JSON.parse(JSON.stringify(swapped)))!;
    expect(loaded.projects[0].tabs[0].cells.map((c) => c.id)).toEqual(swapped.projects[0].tabs[0].cells.map((c) => c.id));
  });
});

describe('cellAtPoint', () => {
  const rects = areaRects(layoutFromRows([2, 1]));

  it('finds the area under a point given as grid fractions', () => {
    expect(cellAtPoint(rects, 0.2, 0.2)).toBe(0);
    expect(cellAtPoint(rects, 0.8, 0.2)).toBe(1);
    expect(cellAtPoint(rects, 0.5, 0.9)).toBe(2);
  });

  it('returns -1 outside the grid and on shared edges only one area wins', () => {
    expect(cellAtPoint(rects, -0.1, 0.5)).toBe(-1);
    expect(cellAtPoint(rects, 0.5, 1.2)).toBe(-1);
    expect(cellAtPoint(rects, 0.5, 0.25)).toBe(1);
  });
});

describe('neighborSlot', () => {
  const layout = layoutForCount(4);

  it('moves to the closest area in each direction', () => {
    expect(neighborSlot(layout.areas, 0, 1, 0)).toBe(1);
    expect(neighborSlot(layout.areas, 0, 0, 1)).toBe(2);
    expect(neighborSlot(layout.areas, 3, -1, 0)).toBe(2);
    expect(neighborSlot(layout.areas, 3, 0, -1)).toBe(1);
  });

  it('returns -1 at the edge of the grid and for a single cell', () => {
    expect(neighborSlot(layout.areas, 0, -1, 0)).toBe(-1);
    expect(neighborSlot(layout.areas, 0, 0, -1)).toBe(-1);
    expect(neighborSlot(layoutForCount(1).areas, 0, 1, 0)).toBe(-1);
  });
});
