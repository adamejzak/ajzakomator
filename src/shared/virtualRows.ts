// Row math of a list whose rows all have the same height: which rows to render for a scroll position.

/** Rows [start, end) to render. */
export interface RowWindow { start: number; end: number }

/**
 * The rows visible in a viewport of `viewport` px scrolled to `scrollTop` px (relative to the first row), plus `overscan`
 * rows on each side so a fast scroll does not show gaps.
 */
export function rowWindow(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 10): RowWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.min(count, Math.floor(Math.max(0, scrollTop) / rowHeight));
  const shown = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
  return { start: Math.max(0, first - overscan), end: Math.min(count, first + shown + overscan) };
}

/** A gap of skipped rows (rendered as one spacer) or a row to render. */
export type RowSlot = { kind: 'gap'; rows: number } | { kind: 'row'; index: number };

/**
 * The slots of a windowed list: the window, plus rows that must stay rendered outside it (the focused one keeps the
 * keyboard focus when it scrolls away), with the skipped rows between them as gaps.
 */
export function rowSlots(window: RowWindow, count: number, keep: readonly number[] = []): RowSlot[] {
  const indexes = new Set<number>();
  for (let i = Math.max(0, window.start); i < Math.min(count, window.end); i++) indexes.add(i);
  for (const i of keep) if (i >= 0 && i < count) indexes.add(i);
  const sorted = [...indexes].sort((a, b) => a - b);
  const out: RowSlot[] = [];
  let next = 0;
  for (const index of sorted) {
    if (index > next) out.push({ kind: 'gap', rows: index - next });
    out.push({ kind: 'row', index });
    next = index + 1;
  }
  if (count > next) out.push({ kind: 'gap', rows: count - next });
  return out;
}
