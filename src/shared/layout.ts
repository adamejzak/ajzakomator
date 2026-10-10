// Grid layouts: a cols×rows grid split into rectangular areas; each area hosts one cell.

export type Area = { col: number; row: number; colSpan: number; rowSpan: number };
export type GridLayout = {
  cols: number;
  rows: number;
  areas: Area[];
  /** Set for row-based layouts (e.g. [3, 2] = three on top, two below); `cols` is then their LCM. */
  rowCounts?: number[];
  /** Relative widths of the `cols` tracks / heights of the `rows` tracks; absent means equal. */
  colSizes?: number[];
  rowSizes?: number[];
};

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
  return layout.rowCounts ? layoutFromRows(layout.rowCounts) : createLayout(layout.cols, layout.rows);
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => (a * b) / gcd(a, b);

/** Each row gets its own number of equally wide cells, e.g. [3, 2]. */
export function layoutFromRows(counts: number[]): GridLayout {
  const rows = counts.map((n) => Math.max(1, Math.min(MAX_COLS, Math.floor(n)))).slice(0, MAX_ROWS);
  if (!rows.length) return createLayout(1, 1);
  if (rows.every((n) => n === rows[0])) return createLayout(rows[0], rows.length);
  const cols = rows.reduce(lcm, 1);
  const areas = rows.flatMap((n, row) =>
    Array.from({ length: n }, (_, i) => ({ col: i * (cols / n), row, colSpan: cols / n, rowSpan: 1 })),
  );
  return { cols, rows: rows.length, areas, rowCounts: rows };
}

/** Cells per row for the row editor (merged layouts report their base rows). */
export function rowCountsOf(layout: GridLayout): number[] {
  return layout.rowCounts ?? Array.from({ length: layout.rows }, () => layout.cols);
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
  if (layout.rowCounts && n === layout.rowCounts.reduce((a, b) => a + b, 0)) return layout.rowCounts.join('+');
  if (n === 1) return '1';
  if (n === layout.cols * layout.rows) return `${layout.cols}×${layout.rows}`;
  return `${n}`;
}

// ── resizable splits ────────────────────────────────────────────────────────

export type Axis = 'col' | 'row';
/** No area may shrink below this share of the whole grid while a divider is dragged. */
export const MIN_AREA_SHARE = 0.1;

const validSizes = (sizes: number[] | undefined, n: number): sizes is number[] =>
  !!sizes && sizes.length === n && sizes.every((v) => Number.isFinite(v) && v > 0);

/** Track weights of an axis; equal when unset or malformed (e.g. a stale value after the grid changed). */
export function trackSizes(layout: GridLayout, axis: Axis): number[] {
  const n = axis === 'col' ? layout.cols : layout.rows;
  const sizes = axis === 'col' ? layout.colSizes : layout.rowSizes;
  return validSizes(sizes, n) ? sizes : Array.from({ length: n }, () => 1);
}

const span = (a: Area, axis: Axis) => (axis === 'col' ? { start: a.col, size: a.colSpan } : { start: a.row, size: a.rowSpan });

/** A divider that exists between areas: grid line `line` (1..n-1), spanning tracks `from`..`to` (inclusive) on the other axis. */
export interface Divider { axis: Axis; line: number; from: number; to: number }

/** Divider segments; a line is split wherever an area spans across it. */
export function dividers(layout: GridLayout): Divider[] {
  const out: Divider[] = [];
  for (const axis of ['col', 'row'] as const) {
    const n = axis === 'col' ? layout.cols : layout.rows;
    const other = axis === 'col' ? layout.rows : layout.cols;
    for (let line = 1; line < n; line++) {
      let from = -1;
      for (let t = 0; t <= other; t++) {
        const real = t < other && layout.areas.some((a) => {
          const m = span(a, axis); const o = span(a, axis === 'col' ? 'row' : 'col');
          return m.start + m.size === line && o.start <= t && t < o.start + o.size;
        }) && layout.areas.some((a) => {
          const m = span(a, axis); const o = span(a, axis === 'col' ? 'row' : 'col');
          return m.start === line && o.start <= t && t < o.start + o.size;
        });
        if (real && from < 0) from = t;
        if (!real && from >= 0) { out.push({ axis, line, from, to: t - 1 }); from = -1; }
      }
    }
  }
  return out;
}

/**
 * Moves grid line `line` by `delta` (in track-weight units, positive = right/down). The two adjacent tracks
 * change in opposite directions so every other line stays put; the move is clamped so no area gets too small.
 */
export function resizeLine(layout: GridLayout, axis: Axis, line: number, delta: number): GridLayout {
  const sizes = trackSizes(layout, axis);
  if (line < 1 || line >= sizes.length) return layout;
  const total = sizes.reduce((a, b) => a + b, 0);
  const min = MIN_AREA_SHARE * total;
  let lo = -sizes[line - 1] + 1e-6 * total;
  let hi = sizes[line] - 1e-6 * total;
  for (const a of layout.areas) {
    const { start, size } = span(a, axis);
    const width = sizes.slice(start, start + size).reduce((x, y) => x + y, 0);
    if (start + size === line) lo = Math.max(lo, Math.min(0, min - width));
    else if (start === line) hi = Math.min(hi, Math.max(0, width - min));
  }
  const d = Math.min(hi, Math.max(lo, delta));
  const next = [...sizes];
  next[line - 1] += d; next[line] -= d;
  return withSizes(layout, axis, next);
}

/** Stores `sizes` for an axis, dropping them when they equal the default split. */
export function withSizes(layout: GridLayout, axis: Axis, sizes: number[] | undefined): GridLayout {
  const key = axis === 'col' ? 'colSizes' : 'rowSizes';
  const { [key]: _old, ...rest } = layout;
  const equal = !sizes || sizes.every((v) => Math.abs(v - sizes[0]) < 1e-6 * sizes[0]);
  return equal ? rest : { ...rest, [key]: sizes };
}
