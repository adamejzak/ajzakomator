// Grid layouts: a cols×rows grid split into rectangular areas; each area hosts one cell.

export type Area = { col: number; row: number; colSpan: number; rowSpan: number };
export type GridLayout = { cols: number; rows: number; areas: Area[] };

export const MAX_COLS = 5;
export const MAX_ROWS = 4;
export const MAX_CELLS = MAX_COLS * MAX_ROWS;

// Auto-grow sequence: [cols, capacity] — 1, 2, 2×2, 3×2, 3×3, 4×3, 5×4.
const GROW_STEPS: Array<[number, number]> = [[1, 1], [2, 2], [2, 4], [3, 6], [3, 9], [4, 12], [5, 20]];

const sortAreas = (areas: Area[]) => [...areas].sort((a, b) => a.row - b.row || a.col - b.col);

export function createLayout(cols: number, rows: number): GridLayout {
  const areas: Area[] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) areas.push({ col, row, colSpan: 1, rowSpan: 1 });
  return { cols, rows, areas };
}

const inside = (a: Area, r: Area) =>
  a.col >= r.col && a.row >= r.row && a.col + a.colSpan <= r.col + r.colSpan && a.row + a.rowSpan <= r.row + r.rowSpan;

const overlaps = (a: Area, r: Area) =>
  a.col < r.col + r.colSpan && r.col < a.col + a.colSpan && a.row < r.row + r.rowSpan && r.row < a.row + a.rowSpan;

/** Merges every area inside `rect` into one. Partial overlaps make the merge invalid → unchanged layout. */
export function mergeRect(layout: GridLayout, rect: Area): GridLayout {
  const hit = layout.areas.filter((a) => overlaps(a, rect));
  if (hit.length < 2 || hit.some((a) => !inside(a, rect))) return layout;
  const rest = layout.areas.filter((a) => !overlaps(a, rect));
  return { ...layout, areas: sortAreas([...rest, { ...rect }]) };
}

export function unmergeAll(layout: GridLayout): GridLayout {
  return createLayout(layout.cols, layout.rows);
}

/** Layout with exactly `n` areas (clamped to 1..MAX_CELLS); the last area stretches over empty fields. */
export function layoutForCount(n: number): GridLayout {
  const count = Math.max(1, Math.min(MAX_CELLS, Math.floor(n)));
  const [cols] = GROW_STEPS.find(([, cap]) => cap >= count)!;
  const rows = Math.ceil(count / cols);
  const layout = createLayout(cols, rows);
  const areas = layout.areas.slice(0, count);
  const last = areas[areas.length - 1];
  last.colSpan = cols - last.col;
  return { cols, rows, areas };
}

export function growLayout(layout: GridLayout): GridLayout | null {
  if (layout.areas.length >= MAX_CELLS) return null;
  return layoutForCount(layout.areas.length + 1);
}

export function removeArea(layout: GridLayout): GridLayout {
  return layoutForCount(layout.areas.length - 1);
}

export function describeLayout(layout: GridLayout): string {
  const n = layout.areas.length;
  if (n === 1) return '1';
  if (n === layout.cols * layout.rows) return `${layout.cols}×${layout.rows}`;
  return `${n}`;
}
