import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { dividerBox, dividers, resetDivider, resizeDivider, type Divider, type GridLayout, type Rect } from '../../../shared/layout';
import { useI18n } from '../i18n';
import { terminals } from '../terminals/TerminalManager';

/** Snap shared edges to CSS pixels, then reserve a 1px grid line. Fractional
 * origins blur a thin frame, especially on the bottom/right after a resize. */
export function areaStyle(rect: Rect): CSSProperties {
  const edge = (share: number) => `round(nearest, ${share * 100}%, 1px)`;
  return {
    left: edge(rect.x0), top: edge(rect.y0),
    width: `calc(${edge(rect.x1)} - ${edge(rect.x0)} - 1px)`,
    height: `calc(${edge(rect.y1)} - ${edge(rect.y0)} - 1px)`,
  };
}

const KEY_STEP = 0.02;

/**
 * Draggable dividers between the grid's areas. Each vertical divider moves one row on its own, horizontal
 * dividers move the whole line; double click restores the equal split.
 */
export function GridDividers({ layout, onPreview, onCommit }: {
  layout: GridLayout;
  onPreview: (layout: GridLayout | null) => void;
  onCommit: (layout: GridLayout) => void;
}) {
  const { tr } = useI18n();
  const drag = useRef<{ base: GridLayout; divider: Divider; start: number; extent: number; current: GridLayout } | null>(null);
  /** The cells are fitted once when the drag ends (see TerminalManager.holdFits). */
  const fitHold = useRef<(() => void) | null>(null);
  useEffect(() => () => { fitHold.current?.(); fitHold.current = null; }, []);

  const begin = (e: PointerEvent<HTMLDivElement>, d: Divider) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = {
      base: layout, divider: d, current: layout,
      start: d.axis === 'col' ? e.clientX : e.clientY,
      extent: d.axis === 'col' ? rect.width : rect.height,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    fitHold.current?.();
    fitHold.current = terminals.holdFits();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.extent <= 0) return;
    const delta = ((g.divider.axis === 'col' ? e.clientX : e.clientY) - g.start) / g.extent;
    g.current = resizeDivider(g.base, g.divider, delta);
    onPreview(g.current);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const release = fitHold.current;
    fitHold.current = null;
    if (release) setTimeout(release, 0); // after the committed layout is rendered
    if (!g) return;
    onPreview(null);
    if (g.current !== g.base) onCommit(g.current);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>, d: Divider) => {
    const forward = d.axis === 'col' ? 'ArrowRight' : 'ArrowDown';
    const backward = d.axis === 'col' ? 'ArrowLeft' : 'ArrowUp';
    if (e.key !== forward && e.key !== backward) return;
    e.preventDefault();
    onCommit(resizeDivider(layout, d, (e.key === forward ? 1 : -1) * KEY_STEP));
  };

  return <>
    {dividers(layout).map((d) => {
      const box = dividerBox(layout, d);
      const style: CSSProperties = d.axis === 'col'
        ? { left: `${box.pos * 100}%`, top: `${box.start * 100}%`, height: `${(box.end - box.start) * 100}%` }
        : { top: `${box.pos * 100}%`, left: `${box.start * 100}%`, width: `${(box.end - box.start) * 100}%` };
      return <div
        key={`${d.axis}:${d.line}:${d.from}`}
        className={`grid-divider ${d.axis}`}
        style={style}
        role="separator"
        aria-orientation={d.axis === 'col' ? 'vertical' : 'horizontal'}
        aria-label={tr('Zmień rozmiar komórek (dwuklik: równy podział)')}
        title={tr('Przeciągnij, aby zmienić rozmiar · dwuklik: równy podział')}
        tabIndex={0}
        onPointerDown={(e) => begin(e, d)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={(e) => key(e, d)}
        onDoubleClick={() => onCommit(resetDivider(layout, d))}
      />;
    })}
  </>;
}
