import { useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { PANEL_LIMITS, type Panel } from '../../../shared/panels';

export interface PanelResizeProps {
  panel: Panel;
  width: number;
  maxWidth: number;
  onResize: (width: number) => void;
  onFinish: (width: number | null) => void;
}

export function PanelResizeHandle({ panel, width, maxWidth, onResize, onFinish }: PanelResizeProps) {
  const { tr } = useI18n();
  const limits = PANEL_LIMITS[panel];
  const max = Math.max(limits.min, Math.min(limits.max, maxWidth));
  const direction = panel === 'sidebar' ? 1 : -1;
  const drag = useRef<{ id: number; x: number; start: number; current: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.round(Math.max(limits.min, Math.min(max, value)));
  const label = panel === 'sidebar' ? tr("Szerokość panelu projektów") : tr("Szerokość panelu snippetów");

  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add('panel-resizing');
    return () => document.documentElement.classList.remove('panel-resizing');
  }, [dragging]);

  const finish = (cancel = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    onFinish(cancel ? null : current.current);
  };

  return (
    <div
      className={`panel-resize edge-${panel} ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={limits.min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={tr('{width} pikseli', { width })}
      tabIndex={0}
      title={tr('{label} · przeciągnij lub użyj strzałek · podwójny klik: domyślna szerokość', { label })}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, start: width, current: width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        if (!current || current.id !== e.pointerId) return;
        current.current = clamp(current.start + (e.clientX - current.x) * direction);
        onResize(current.current);
      }}
      onPointerUp={(e) => {
        finish();
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={() => finish()}
      onDoubleClick={() => onFinish(clamp(limits.default))}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && drag.current) {
          e.preventDefault();
          finish(true);
          return;
        }
        const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (delta) {
          e.preventDefault();
          e.stopPropagation();
          onFinish(clamp(width + delta * direction * (e.shiftKey ? 40 : 10)));
        } else if (e.key === 'Home' || e.key === 'End' || e.key === 'Enter') {
          e.preventDefault();
          onFinish(e.key === 'Home' ? limits.min : e.key === 'End' ? max : clamp(limits.default));
        }
      }}
    />
  );
}
