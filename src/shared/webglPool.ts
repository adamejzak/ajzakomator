// Which terminals keep a WebGL renderer. Pure, so the policy is tested without a browser.
export interface WebglCandidate {
  id: string;
  /** Currently has a WebGL context. */
  hasWebgl: boolean;
  /** Currently shown in a cell. */
  attached: boolean;
  /** When it was last shown or hidden (performance.now()). */
  shownAt: number;
}

/**
 * A terminal about to be shown wants a context. Returns whether it may have one and which parked terminals have to release
 * theirs (least recently shown first) so that at most `limit` contexts exist afterwards. Terminals on screen never lose theirs.
 */
export function planWebglSlot(candidates: readonly WebglCandidate[], limit: number): { allowed: boolean; release: string[] } {
  const live = candidates.filter((c) => c.hasWebgl);
  const excess = live.length - limit + 1; // after the new one is added
  if (excess <= 0) return { allowed: true, release: [] };
  const parked = live.filter((c) => !c.attached).sort((a, b) => a.shownAt - b.shownAt);
  if (parked.length < excess) return { allowed: false, release: [] };
  return { allowed: true, release: parked.slice(0, excess).map((c) => c.id) };
}
