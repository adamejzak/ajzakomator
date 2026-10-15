// Zoom of the file views (editor, large text, tables, diffs, Markdown): Ctrl + wheel, Ctrl + / - / 0. One value for all tabs, remembered.
import { useSyncExternalStore } from 'react';

const KEY = 'mc-file-zoom-v1';
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 3;
const STEP = 0.1;

const clamp = (value: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
function read(): number {
  try { const stored = Number(localStorage.getItem(KEY)); return Number.isFinite(stored) && stored > 0 ? clamp(stored) : 1; } catch { return 1; }
}

let zoom = read();
const listeners = new Set<() => void>();

export function setFileZoom(value: number): void {
  const next = clamp(value);
  if (next === zoom) return;
  zoom = next;
  try { localStorage.setItem(KEY, String(next)); } catch { /* the zoom still applies for this run */ }
  listeners.forEach((listener) => listener());
}
export const stepFileZoom = (direction: 1 | -1): void => setFileZoom(zoom + direction * STEP);
export const useFileZoom = (): number => useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => zoom);

/** The zoom shortcuts of a view: true when the event was one (and has been handled). */
export function handleZoomKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault(): void }): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false;
  if (event.key === '+' || event.key === '=') stepFileZoom(1);
  else if (event.key === '-' || event.key === '_') stepFileZoom(-1);
  else if (event.key === '0') setFileZoom(1);
  else return false;
  event.preventDefault();
  return true;
}
