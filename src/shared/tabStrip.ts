// Pure scroll logic of the workspace tab strip (many open tabs overflow horizontally).

export interface ScrollEdges { canLeft: boolean; canRight: boolean }

/** Which scroll buttons make sense (1px tolerance for fractional layouts). */
export function scrollEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): ScrollEdges {
  return { canLeft: scrollLeft > 1, canRight: scrollLeft + clientWidth < scrollWidth - 1 };
}

/** New scrollLeft that brings an item fully into view with a little padding; unchanged when it is already visible. */
export function revealScroll(view: { scrollLeft: number; width: number; scrollWidth: number }, item: { left: number; width: number }, pad = 28): number {
  const max = Math.max(0, view.scrollWidth - view.width);
  let next = view.scrollLeft;
  if (item.left - pad < next) next = item.left - pad;
  else if (item.left + item.width + pad > next + view.width) next = item.left + item.width + pad - view.width;
  return Math.min(max, Math.max(0, next));
}

/** One click of a scroll arrow moves by most of the visible width (at least 120px). */
export function stepScroll(direction: -1 | 1, clientWidth: number): number {
  return direction * Math.max(120, Math.round(clientWidth * 0.6));
}

/** Horizontal pixels for a wheel event over the strip: a vertical wheel scrolls sideways. */
export function wheelScroll(event: { deltaX: number; deltaY: number; deltaMode: number }, clientWidth: number): number {
  const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  return event.deltaMode === 1 ? raw * 40 : event.deltaMode === 2 ? raw * clientWidth : raw;
}
