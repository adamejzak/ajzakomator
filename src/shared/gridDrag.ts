// Pure helpers for rearranging cells in a grid. A swap only exchanges which cell sits in which area slot
// (`tab.cells[i]` lives in `layout.areas[i]`), so sizes and dividers never move.
import type { Area, Rect } from './layout';

/** Index of the area under a point given as fractions of the grid (half-open rects), or -1. */
export function cellAtPoint(rects: readonly Rect[], fx: number, fy: number): number {
  return rects.findIndex((r) => fx >= r.x0 && fx < r.x1 && fy >= r.y0 && fy < r.y1);
}

/** Closest area from `idx` in direction (dx, dy), each -1, 0 or 1; -1 when there is none. */
export function neighborSlot(areas: readonly Area[], idx: number, dx: number, dy: number): number {
  const cur = areas[idx];
  if (!cur) return -1;
  const cx = cur.col + cur.colSpan / 2;
  const cy = cur.row + cur.rowSpan / 2;
  let best = -1;
  let bestDist = Infinity;
  areas.forEach((a, i) => {
    if (i === idx) return;
    const ddx = a.col + a.colSpan / 2 - cx;
    const ddy = a.row + a.rowSpan / 2 - cy;
    if ((dx && Math.sign(ddx) !== dx) || (dy && Math.sign(ddy) !== dy)) return;
    const dist = Math.abs(ddx) * (dx ? 1 : 3) + Math.abs(ddy) * (dy ? 1 : 3);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}
