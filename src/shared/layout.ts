// Grid layouts: a cols×rows grid split into rectangular areas; each area hosts one cell.

export type Area = { col: number; row: number; colSpan: number; rowSpan: number };
export type GridLayout = {
  cols: number;
  rows: number;
  areas: Area[];
  /** Set for row-based layouts (e.g. [3, 2] = three on top, two below); `cols` is then their LCM. */
  rowCounts?: number[];
  /** Relative heights of the `rows` tracks; absent means equal. */
  rowSizes?: number[];
  /** Relative widths of the `cols` tracks for each row; `null` entries (or no field) mean equal. */
  rowColSizes?: Array<number[] | null>;
  /** Grid-wide column widths written by 0.5.5; read as the default for every row. */
  colSizes?: number[];
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
  // Merged areas span rows, so per-row column widths no longer apply.
  const { rowColSizes: _widths, colSizes: _legacy, ...kept } = layout;
  return { ...kept, areas: sortAreas([...rest, { ...rect }]) };
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
//
// Heights are shared by the whole width (`rowSizes`), widths belong to each row (`rowColSizes`), so a row's
// vertical dividers can move without touching the other rows. Every combination stays a gap-free tiling.

export type Axis = 'col' | 'row';
/** No area may shrink below this share of the grid while a divider is dragged. */
export const MIN_AREA_SHARE = 0.1;

const validSizes = (sizes: readonly number[] | null | undefined, n: number): sizes is number[] =>
  !!sizes && sizes.length === n && sizes.every((v) => Number.isFinite(v) && v > 0);
const equalSizes = (n: number) => Array.from({ length: n }, () => 1);
const sum = (values: readonly number[], from = 0, to = values.length) => values.slice(from, to).reduce((a, b) => a + b, 0);

/** Row heights (relative); equal when unset or stale. */
export function rowWeights(layout: GridLayout): number[] {
  return validSizes(layout.rowSizes, layout.rows) ? layout.rowSizes : equalSizes(layout.rows);
}

/** Column widths (relative) of one row; equal when unset or stale. `colSizes` is the older grid-wide form. */
export function colWeights(layout: GridLayout, row: number): number[] {
  const own = layout.rowColSizes?.[row];
  if (validSizes(own, layout.cols)) return own;
  return validSizes(layout.colSizes, layout.cols) ? layout.colSizes : equalSizes(layout.cols);
}

/** Position and size of every area as fractions of the grid (same order as `layout.areas`). */
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export function areaRects(layout: GridLayout): Rect[] {
  const rows = rowWeights(layout);
  const height = sum(rows);
  return layout.areas.map((a) => {
    const cols = colWeights(layout, a.row);
    const width = sum(cols);
    return {
      x0: sum(cols, 0, a.col) / width, x1: sum(cols, 0, a.col + a.colSpan) / width,
      y0: sum(rows, 0, a.row) / height, y1: sum(rows, 0, a.row + a.rowSpan) / height,
    };
  });
}

/** A divider between areas: grid line `line` (1..n-1) over the other axis' tracks `from`..`to` (inclusive). */
export interface Divider { axis: Axis; line: number; from: number; to: number }

const along = (a: Area, axis: Axis) => (axis === 'col' ? { start: a.col, size: a.colSpan } : { start: a.row, size: a.rowSpan });
const across = (a: Area, axis: Axis) => along(a, axis === 'col' ? 'row' : 'col');

/**
 * Divider segments. A vertical line is cut at every crossing with a horizontal divider ("+" junctions), so
 * each row's divider moves on its own; it stays in one piece where an area spans across (T junctions).
 * Horizontal dividers span the full width and are only interrupted where an area crosses them.
 */
export function dividers(layout: GridLayout): Divider[] {
  const out: Divider[] = [];
  for (const axis of ['col', 'row'] as const) {
    const n = axis === 'col' ? layout.cols : layout.rows;
    const other = axis === 'col' ? layout.rows : layout.cols;
    for (let line = 1; line < n; line++) {
      const touches = (t: number, side: 'end' | 'start') => layout.areas.some((a) => {
        const m = along(a, axis); const o = across(a, axis);
        return (side === 'end' ? m.start + m.size === line : m.start === line) && o.start <= t && t < o.start + o.size;
      });
      // An area on this side finishes right after track t: a perpendicular divider meets the line here.
      const corner = (t: number, side: 'end' | 'start') => layout.areas.some((a) => {
        const m = along(a, axis); const o = across(a, axis);
        return (side === 'end' ? m.start + m.size === line : m.start === line) && o.start + o.size === t + 1;
      });
      let from = -1;
      for (let t = 0; t < other; t++) {
        const real = touches(t, 'end') && touches(t, 'start');
        if (real && from < 0) from = t;
        const cut = t === other - 1 || (axis === 'col' && corner(t, 'end') && corner(t, 'start'));
        if (real && cut) { out.push({ axis, line, from, to: t }); from = -1; }
        else if (!real) from = -1;
      }
    }
  }
  return out;
}

/** Where to draw a divider, as fractions of the grid: its line coordinate and its extent along the line. */
export function dividerBox(layout: GridLayout, d: Divider): { pos: number; start: number; end: number } {
  const rows = rowWeights(layout);
  if (d.axis === 'col') {
    const cols = colWeights(layout, d.from);
    return { pos: sum(cols, 0, d.line) / sum(cols), start: sum(rows, 0, d.from) / sum(rows), end: sum(rows, 0, d.to + 1) / sum(rows) };
  }
  const rects = areaRects(layout);
  const touching = rects.filter((_, i) => { const a = layout.areas[i]; return a.row + a.rowSpan === d.line && a.col <= d.to && d.from < a.col + a.colSpan; });
  return { pos: sum(rows, 0, d.line) / sum(rows), start: Math.min(...touching.map((r) => r.x0)), end: Math.max(...touching.map((r) => r.x1)) };
}

/** Clamp range for moving grid line `line` of a weight list by a fraction of its total. */
function moveLimits(weights: number[], spans: Array<{ start: number; size: number }>, line: number): [number, number] {
  const total = sum(weights);
  let lo = -(weights[line - 1] / total) + 1e-6;
  let hi = weights[line] / total - 1e-6;
  for (const { start, size } of spans) {
    const width = sum(weights, start, start + size) / total;
    if (start + size === line) lo = Math.max(lo, Math.min(0, MIN_AREA_SHARE - width));
    else if (start === line) hi = Math.min(hi, Math.max(0, width - MIN_AREA_SHARE));
  }
  return [lo, hi];
}

const shift = (weights: number[], line: number, delta: number) => {
  const total = sum(weights);
  const next = [...weights];
  next[line - 1] += delta * total; next[line] -= delta * total;
  return next;
};

/**
 * Moves a divider by `delta` (fraction of the grid, positive = right/down). A vertical divider only moves
 * the rows it spans; a horizontal one moves the whole line. The move is clamped so no area gets too small.
 */
export function resizeDivider(layout: GridLayout, d: Divider, delta: number): GridLayout {
  if (d.axis === 'row') {
    const weights = rowWeights(layout);
    if (d.line < 1 || d.line >= weights.length) return layout;
    const [lo, hi] = moveLimits(weights, layout.areas.map((a) => along(a, 'row')), d.line);
    return withRowSizes(layout, shift(weights, d.line, Math.min(hi, Math.max(lo, delta))));
  }
  if (d.line < 1 || d.line >= layout.cols) return layout;
  let lo = -Infinity;
  let hi = Infinity;
  for (let t = d.from; t <= d.to; t++) {
    const touching = layout.areas.filter((a) => a.row <= t && t < a.row + a.rowSpan && (a.col + a.colSpan === d.line || a.col === d.line));
    const [l, h] = moveLimits(colWeights(layout, t), touching.map((a) => along(a, 'col')), d.line);
    lo = Math.max(lo, l); hi = Math.min(hi, h);
  }
  const clamped = Math.min(hi, Math.max(lo, delta));
  const rowColSizes = Array.from({ length: layout.rows }, (_, t) => layout.rowColSizes?.[t] ?? null);
  for (let t = d.from; t <= d.to; t++) rowColSizes[t] = shift(colWeights(layout, t), d.line, clamped);
  return withRowColSizes(layout, rowColSizes);
}

/** Restores the equal split of the rows a divider spans (vertical) or of all heights (horizontal). */
export function resetDivider(layout: GridLayout, d: Divider): GridLayout {
  if (d.axis === 'row') return withRowSizes(layout, undefined);
  const rowColSizes = Array.from({ length: layout.rows }, (_, t) => (t >= d.from && t <= d.to ? null : layout.rowColSizes?.[t] ?? null));
  return withRowColSizes(layout, rowColSizes);
}

const isEqual = (sizes: number[]) => sizes.every((v) => Math.abs(v - sizes[0]) < 1e-6 * sizes[0]);

/** Stores row heights, dropping them when they equal the default split. */
export function withRowSizes(layout: GridLayout, sizes: number[] | undefined): GridLayout {
  const { rowSizes: _old, ...rest } = layout;
  return !sizes || isEqual(sizes) ? rest : { ...rest, rowSizes: sizes };
}

/** Stores per-row column widths (`null` = default), dropping the field when nothing is customised. */
export function withRowColSizes(layout: GridLayout, sizes: Array<number[] | null>): GridLayout {
  const { rowColSizes: _old, colSizes: legacy, ...rest } = layout;
  const custom = sizes.map((row) => (row && !isEqual(row) ? row : null));
  // Rows that were not customised keep the grid-wide widths written by 0.5.5, if any.
  const base = legacy ? { colSizes: legacy } : {};
  if (!custom.some(Boolean)) return { ...rest, ...base };
  const filled = custom.map((row, t) => row ?? (legacy && validSizes(legacy, layout.cols) ? legacy : null));
  return { ...rest, ...base, rowColSizes: filled };
}
