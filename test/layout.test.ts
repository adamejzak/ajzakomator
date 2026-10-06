import { describe, expect, it } from 'vitest';
import { createLayout, describeLayout, growLayout, layoutForCount, layoutFromRows, mergeRect, removeArea, rowCountsOf, unmergeAll } from '../src/shared/layout';

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
