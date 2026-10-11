import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cellAtPoint } from '../../../shared/gridDrag';
import type { Rect } from '../../../shared/layout';
import type { Cell } from '../../../shared/types';

/** Pointer travel (px) before a header press turns into a drag, so plain clicks and double clicks keep working. */
const THRESHOLD = 4;

export interface CellDrag { id: string; target: string | null }
export interface DragContext { grid: HTMLElement; ids: string[]; rects: Rect[] }

/**
 * Drag a cell by its header onto another cell to swap them. Pointer events (like the dividers) are used rather
 * than HTML5 drag and drop: no drag image, no native drop effects, and the pointer stays captured by the header
 * so the terminals below never see the events. Nothing about the grid layout changes while dragging; only the
 * floating ghost moves (directly through its style, no re-render) and React state changes when the target does.
 */
export function useCellDrag(getContext: () => DragContext | null, onDrop: (source: string, target: string) => void) {
  const [drag, setDrag] = useState<CellDrag | null>(null);
  const ghost = useRef<HTMLElement | null>(null);
  const pos = useRef({ x: 0, y: 0 });
  const stop = useRef<(() => void) | null>(null);
  const latest = useRef({ getContext, onDrop });
  latest.current = { getContext, onDrop };

  useEffect(() => () => stop.current?.(), []);

  const place = (el: HTMLElement) => {
    el.style.transform = `translate3d(${pos.current.x + 14}px, ${pos.current.y + 12}px, 0)`;
  };
  const ghostRef = useCallback((el: HTMLElement | null) => {
    ghost.current = el;
    if (el) place(el);
  }, []);

  const onHeadPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>, cell: Cell) => {
    if (e.button !== 0 || stop.current || !e.isPrimary) return;
    if ((e.target as HTMLElement).closest('button,input,.profile')) return;
    const head = e.currentTarget;
    const pointerId = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let target: string | null = null;
    let frame = 0;

    const resolve = (): string | null => {
      const ctx = latest.current.getContext();
      if (!ctx) return null;
      const box = ctx.grid.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      const idx = cellAtPoint(ctx.rects, (pos.current.x - box.left) / box.width, (pos.current.y - box.top) / box.height);
      return idx >= 0 && ctx.ids[idx] !== cell.id ? ctx.ids[idx] : null;
    };
    const retarget = () => {
      frame = 0;
      const next = resolve();
      if (next === target) return;
      target = next;
      setDrag({ id: cell.id, target });
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      pos.current = { x: ev.clientX, y: ev.clientY };
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < THRESHOLD) return;
        dragging = true;
        try { head.setPointerCapture(pointerId); } catch { /* the pointer is already gone */ }
        window.getSelection()?.removeAllRanges();
        document.body.classList.add('cell-dragging');
        setDrag({ id: cell.id, target: null });
      }
      if (ghost.current) place(ghost.current);
      if (!frame) frame = requestAnimationFrame(retarget);
    };
    const finish = (commit: boolean) => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onCancel);
      document.body.classList.remove('cell-dragging');
      if (head.hasPointerCapture?.(pointerId)) head.releasePointerCapture(pointerId);
      stop.current = null;
      if (!dragging) return;
      setDrag(null);
      // The pointerup after a drag would otherwise click whatever the header contains.
      const swallow = (ev: Event) => ev.stopPropagation();
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      const final = commit ? resolve() : null;
      if (final) latest.current.onDrop(cell.id, final);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      pos.current = { x: ev.clientX, y: ev.clientY };
      finish(true);
    };
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };

    stop.current = () => finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onCancel);
  }, []);

  return { drag, ghostRef, onHeadPointerDown };
}
