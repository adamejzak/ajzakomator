// Which terminals keep a WebGL renderer. Pure, so the policy is tested without a browser.
export interface WebglCandidate {
  id: string;
  /** Currently has a WebGL context. */
  hasWebgl: boolean;
  /** Currently shown in a cell. */
  attached: boolean;
  /** When it was last shown or hidden (performance.now()). */
  shownAt: number;
  /** Has the keyboard focus. */
  focused?: boolean;
  /** Last output (performance.now()). */
  outputAt?: number;
  /** When its context was last created or given back (performance.now()). */
  changedAt?: number;
  /** No new context before this time (a lost context backs off). */
  blockedUntil?: number;
}

/** An on-screen terminal keeps a context it just got, and waits after losing one, at least this long (no thrashing). */
export const WEBGL_HOLD_MS = 4000;
/** Output this recent makes a terminal "busy": it may take a context from a quiet one on screen. */
export const WEBGL_BUSY_MS = 3000;

/** 3 = focused, 2 = recent output, 1 = shown and quiet. */
function rank(c: WebglCandidate, now: number): number {
  if (c.focused) return 3;
  return c.outputAt !== undefined && now - c.outputAt < WEBGL_BUSY_MS ? 2 : 1;
}

const settled = (c: WebglCandidate, now: number) => c.changedAt === undefined || now - c.changedAt >= WEBGL_HOLD_MS;

/**
 * Who gets a context and who gives one back so that at most `limit` exist. On-screen terminals without one are served by
 * rank (focused, then busy, then quiet): first from free slots, then from parked terminals (least recently shown first), and
 * only then from an on-screen terminal of a lower rank. Taking one from the screen happens at most once per plan, only from a
 * terminal that held its context for WEBGL_HOLD_MS and for a terminal that did not just lose one, so a plan run every second
 * swaps at most one context per second and never the same cell back and forth. Parked terminals keep theirs while slots are free.
 */
export function planWebgl(candidates: readonly WebglCandidate[], limit: number, now: number): { grant: string[]; release: string[] } {
  const grant: string[] = [];
  const release: string[] = [];
  const holders = candidates.filter((c) => c.hasWebgl);
  const parked = holders.filter((c) => !c.attached).sort((a, b) => a.shownAt - b.shownAt);
  // A lowered limit: parked terminals give back the excess first.
  let used = holders.length;
  while (used > limit && parked.length) { release.push(parked.shift()!.id); used--; }
  const wanting = candidates
    .filter((c) => c.attached && !c.hasWebgl && !(c.blockedUntil !== undefined && c.blockedUntil > now))
    .sort((a, b) => rank(b, now) - rank(a, now) || (b.outputAt ?? 0) - (a.outputAt ?? 0) || b.shownAt - a.shownAt);
  // On-screen holders that could give theirs up, the cheapest loss first.
  const shown = holders.filter((c) => c.attached && !c.focused && settled(c, now))
    .sort((a, b) => rank(a, now) - rank(b, now) || (a.outputAt ?? 0) - (b.outputAt ?? 0));
  let swapped = false;
  for (const c of wanting) {
    if (used < limit) { grant.push(c.id); used++; continue; }
    const victim = parked.shift();
    if (victim) { release.push(victim.id); grant.push(c.id); continue; }
    if (swapped || !settled(c, now)) continue;
    const loser = shown[0];
    if (!loser || rank(loser, now) >= rank(c, now)) break;
    shown.shift();
    release.push(loser.id);
    grant.push(c.id);
    swapped = true;
  }
  return { grant, release };
}

/**
 * Back-off after a lost context: 2 s, doubling with each loss in a row, at most a minute. Losses spread wider than a minute
 * apart start over.
 */
export function webglBackoff(losses: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, losses - 1));
}
