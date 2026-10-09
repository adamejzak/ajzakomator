import type { DropEdge } from '../../../shared/state';

export function dropEdge(element: HTMLElement, clientY: number): DropEdge {
  const bounds = element.getBoundingClientRect();
  return clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

/** Keep long lists usable while dragging an item past the visible portion. */
export function scrollDragList(element: HTMLElement, clientY: number): void {
  const bounds = element.getBoundingClientRect();
  const distance = 32;
  if (clientY < bounds.top + distance) element.scrollTop -= 12;
  else if (clientY > bounds.bottom - distance) element.scrollTop += 12;
}
