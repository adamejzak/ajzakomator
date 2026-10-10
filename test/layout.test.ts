import { describe, expect, it } from 'vitest';
import { createLayout, describeLayout, dividers, growLayout, layoutForCount, layoutFromRows, mergeRect, MIN_AREA_SHARE, removeArea, resizeLine, rowCountsOf, trackSizes, unmergeAll, withSizes } from '../src/shared/layout';

describe('layout', () => {
  it('createLayout makes one area per field, row-major', () => {
    const l = createLayout(2, 2);
    expect(l.areas).toHaveLength(4);
    expect(l.areas[1]).toEqual({ col: 1, row: 0, colSpan: 1, rowSpan: 1 });
    expect(l.areas[2]).toEqual({ col: 0, row: 1, colSpan: 1, rowSpan: 1 });
  });

  it('mergeRect replaces fully covered areas with one spanning area', () => {
    const l = mergeRect(createLayout(2, 2), { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    expect(l.areas).toHaveLength(3);
    expect(l.areas[0]).toEqual({ col: 0, row: 0, colSpan: 2, rowSpan: 1 });
  });

  it('mergeRect leaves layout unchanged on partial overlap', () => {
    const merged = mergeRect(createLayout(3, 1), { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    const again = mergeRect(merged, { col: 1, row: 0, colSpan: 2, rowSpan: 1 });
    expect(again).toEqual(merged);
  });

  it('unmergeAll restores single fields', () => {
    const l = unmergeAll(mergeRect(createLayout(2, 2), { col: 0, row: 0, colSpan: 2, rowSpan: 2 }));
    expect(l.areas).toHaveLength(4);
  });

  it('layoutForCount follows the auto-grow sequence with exactly n areas', () => {
    expect(layoutForCount(1)).toMatchObject({ cols: 1, rows: 1 });
    expect(layoutForCount(2)).toMatchObject({ cols: 2, rows: 1 });
    expect(layoutForCount(4)).toMatchObject({ cols: 2, rows: 2 });
    const five = layoutForCount(5);
    expect(five).toMatchObject({ cols: 3, rows: 2 });
    expect(five.areas).toHaveLength(5);
    expect(five.areas[4]).toEqual({ col: 1, row: 1, colSpan: 2, rowSpan: 1 });
    expect(layoutForCount(12)).toMatchObject({ cols: 4, rows: 3 });
    expect(layoutForCount(13)).toMatchObject({ cols: 5, rows: 3 });
    expect(layoutForCount(99).areas).toHaveLength(20);
  });

  it('growLayout adds one area, null at max', () => {
    expect(growLayout(layoutForCount(4))!.areas).toHaveLength(5);
    expect(growLayout(layoutForCount(20))).toBeNull();
  });

  it('layoutFromRows builds 3 on top and 2 below', () => {
    const l = layoutFromRows([3, 2]);
    expect(l).toMatchObject({ cols: 6, rows: 2, rowCounts: [3, 2] });
    expect(l.areas).toHaveLength(5);
    expect(l.areas[0]).toEqual({ col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    expect(l.areas[4]).toEqual({ col: 3, row: 1, colSpan: 3, rowSpan: 1 });
    expect(describeLayout(l)).toBe('3+2');
  });

  it('layoutFromRows with equal rows is a plain grid', () => {
    expect(layoutFromRows([2, 2])).toEqual(createLayout(2, 2));
    expect(rowCountsOf(createLayout(4, 3))).toEqual([4, 4, 4]);
  });

  it('unmergeAll on a row layout restores its rows', () => {
    const l = layoutFromRows([3, 2]);
    const merged = mergeRect(l, { col: 0, row: 0, colSpan: 4, rowSpan: 1 });
    expect(merged.areas).toHaveLength(4);
    expect(unmergeAll(merged)).toEqual(l);
  });

  it('removeArea shrinks to n-1 but never below 1', () => {
    expect(removeArea(layoutForCount(4)).areas).toHaveLength(3);
    expect(removeArea(layoutForCount(1)).areas).toHaveLength(1);
  });
});

describe('resizable splits', () => {
  const total = (sizes: number[]) => sizes.reduce((a, b) => a + b, 0);

  it('uses equal tracks until sizes are set and ignores malformed sizes', () => {
    expect(trackSizes(createLayout(3, 1), 'col')).toEqual([1, 1, 1]);
    expect(trackSizes({ ...createLayout(2, 2), colSizes: [1, 2, 3] }, 'col')).toEqual([1, 1]);
    expect(trackSizes({ ...createLayout(2, 2), rowSizes: [1, -1] }, 'row')).toEqual([1, 1]);
  });

  it('finds every divider of a plain grid as one full-length segment', () => {
    expect(dividers(createLayout(2, 2))).toEqual([
      { axis: 'col', line: 1, from: 0, to: 1 },
      { axis: 'row', line: 1, from: 0, to: 1 },
    ]);
    expect(dividers(createLayout(1, 1))).toEqual([]);
  });

  it('splits a divider where an area spans across it', () => {
    const merged = mergeRect(createLayout(2, 2), { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
    expect(dividers(merged)).toEqual([
      { axis: 'col', line: 1, from: 1, to: 1 },
      { axis: 'row', line: 1, from: 0, to: 1 },
    ]);
  });

  it('offers per-row dividers for uneven rows', () => {
    const l = layoutFromRows([3, 2]);
    const verticals = dividers(l).filter((d) => d.axis === 'col').map((d) => [d.line, d.from, d.to]);
    expect(verticals).toEqual([[2, 0, 0], [3, 1, 1], [4, 0, 0]]);
  });

  it('moves one line, keeps the total and leaves other lines in place', () => {
    const moved = resizeLine(createLayout(3, 1), 'col', 1, 0.5);
    expect(moved.colSizes).toEqual([1.5, 0.5, 1]);
    expect(total(moved.colSizes!)).toBe(3);
    const second = resizeLine(moved, 'col', 2, -0.25);
    expect(second.colSizes![0]).toBe(1.5);
    expect(total(second.colSizes!)).toBeCloseTo(3);
  });

  it('never lets an area shrink below the minimum share', () => {
    const grid = createLayout(2, 1);
    const far = resizeLine(grid, 'col', 1, 5);
    expect(far.colSizes![1] / total(far.colSizes!)).toBeCloseTo(MIN_AREA_SHARE);
    const back = resizeLine(grid, 'col', 1, -5);
    expect(back.colSizes![0] / total(back.colSizes!)).toBeCloseTo(MIN_AREA_SHARE);
  });

  it('respects merged areas when clamping', () => {
    const merged = mergeRect(createLayout(3, 1), { col: 1, row: 0, colSpan: 2, rowSpan: 1 });
    const squeezed = resizeLine(merged, 'col', 1, 5);
    const sizes = squeezed.colSizes!;
    expect((sizes[1] + sizes[2]) / total(sizes)).toBeGreaterThanOrEqual(MIN_AREA_SHARE - 1e-9);
  });

  it('drops sizes when they return to an equal split and survives merging', () => {
    const l = resizeLine(createLayout(2, 2), 'col', 1, 0.4);
    expect(l.colSizes).toBeDefined();
    expect(withSizes(l, 'col', undefined).colSizes).toBeUndefined();
    expect(resizeLine(l, 'col', 1, -0.4).colSizes).toBeUndefined();
    expect(mergeRect(l, { col: 0, row: 0, colSpan: 1, rowSpan: 2 }).colSizes).toEqual(l.colSizes);
  });

  it('ignores lines outside the grid', () => {
    const l = createLayout(2, 1);
    expect(resizeLine(l, 'col', 0, 1)).toBe(l);
    expect(resizeLine(l, 'col', 2, 1)).toBe(l);
  });
});
