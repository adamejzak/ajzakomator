// FLIP animation for cells that change slots: the DOM already holds the final geometry, so cells are animated
// with a transform from their old rect. Width and height never transition, hence the terminals are not refitted
// frame by frame.

export const SWAP_MS = 180;

let before: Map<string, DOMRect> | null = null;

const cellElements = () => Array.from(document.querySelectorAll<HTMLElement>('.grid [data-cell-id]'));

/** Remember where every cell is now; call right before the state change that reorders the cells. */
export function snapshotCellRects(): void {
  before = new Map(cellElements().map((el) => [el.dataset.cellId!, el.getBoundingClientRect()]));
}

/** Animate cells from the snapshot to where they are now; call after the reordered render was committed. */
export function playCellMotion(): void {
  const from = before;
  before = null;
  if (!from || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of cellElements()) {
    const old = from.get(el.dataset.cellId!);
    const now = el.getBoundingClientRect();
    if (!old || !now.width || !now.height) continue;
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    const sx = old.width / now.width;
    const sy = old.height / now.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }],
      { duration: SWAP_MS, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }
}
