import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { dividers, resizeLine, trackSizes, withSizes, type Axis, type Divider, type GridLayout } from '../../../shared/layout';
import { useI18n } from '../i18n';

/** Fraction of an axis covered by tracks `from`..`to-1`. */
const fraction = (sizes: number[], from: number, to: number) => {
  const total = sizes.reduce((a, b) => a + b, 0);
  return sizes.slice(from, to).reduce((a, b) => a + b, 0) / total;
};

/** CSS track list for an axis; weights are normalised so the tracks always fill the grid. */
export function trackTemplate(layout: GridLayout, axis: Axis): string {
  const sizes = trackSizes(layout, axis);
  const total = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((w) => `minmax(0, ${((w / total) * sizes.length).toFixed(4)}fr)`).join(' ');
}

const KEY_STEP = 0.02;

/** Draggable dividers between the grid's areas; double click restores the equal split of that axis. */
export function GridDividers({ layout, onPreview, onCommit }: {
  layout: GridLayout;
  onPreview: (layout: GridLayout | null) => void;
  onCommit: (layout: GridLayout) => void;
}) {
  const { tr } = useI18n();
  const drag = useRef<{ base: GridLayout; axis: Axis; line: number; start: number; extent: number; weights: number; current: GridLayout } | null>(null);
  const cols = trackSizes(layout, 'col');
  const rows = trackSizes(layout, 'row');

  const begin = (e: PointerEvent<HTMLDivElement>, d: Divider) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const sizes = d.axis === 'col' ? cols : rows;
    drag.current = {
      base: layout, axis: d.axis, line: d.line, current: layout,
      start: d.axis === 'col' ? e.clientX : e.clientY,
      extent: d.axis === 'col' ? rect.width : rect.height,
      weights: sizes.reduce((a, b) => a + b, 0),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.extent <= 0) return;
    const delta = ((g.axis === 'col' ? e.clientX : e.clientY) - g.start) / g.extent * g.weights;
    g.current = resizeLine(g.base, g.axis, g.line, delta);
    onPreview(g.current);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g) return;
    onPreview(null);
    if (g.current !== g.base) onCommit(g.current);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>, d: Divider) => {
    const forward = d.axis === 'col' ? 'ArrowRight' : 'ArrowDown';
    const backward = d.axis === 'col' ? 'ArrowLeft' : 'ArrowUp';
    if (e.key !== forward && e.key !== backward) return;
    e.preventDefault();
    const weights = (d.axis === 'col' ? cols : rows).reduce((a, b) => a + b, 0);
    onCommit(resizeLine(layout, d.axis, d.line, (e.key === forward ? 1 : -1) * KEY_STEP * weights));
  };

  return <>
    {dividers(layout).map((d) => {
      const style = d.axis === 'col'
        ? { left: `${fraction(cols, 0, d.line) * 100}%`, top: `${fraction(rows, 0, d.from) * 100}%`, height: `${fraction(rows, d.from, d.to + 1) * 100}%` }
        : { top: `${fraction(rows, 0, d.line) * 100}%`, left: `${fraction(cols, 0, d.from) * 100}%`, width: `${fraction(cols, d.from, d.to + 1) * 100}%` };
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
        onKeyDown={(e) => key(e, d)}
        onDoubleClick={() => onCommit(withSizes(layout, d.axis, undefined))}
      />;
    })}
  </>;
}
