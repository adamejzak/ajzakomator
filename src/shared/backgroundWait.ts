// Claude Code prints "Waiting for N dynamic workflow(s) to finish" (its turn-duration row) when a turn ends while background
// work it started itself still runs. The row is frozen: it stays in the transcript after the work is done. This English
// TUI text is therefore only a veto for the silence net of a cell already in background mode from the Stop payload
// (StatusTracker.bgGuard in src/shared/status.ts, capped at WORKFLOW_STALL_MS); it never holds a real Stop and is never the
// source of a status. No DOM imports: tested in Node.

/** A line that starts (after a bullet or spinner glyph) with the wait text; prose that merely mentions waiting never matches. */
const BACKGROUND_WAIT = /^[^\w]{0,6}Waiting for \d+ (?:dynamic |background )?(?:workflows?|agents?|tasks?)\b/;
/** How many rows at the bottom of the screen are looked at. */
export const WAIT_ROWS = 8;

export function matchesBackgroundWait(text: string): boolean {
  return BACKGROUND_WAIT.test(text.trimEnd());
}

/** The part of an xterm.js buffer this needs (`term.buffer.active`). */
export interface WaitBuffer {
  baseY: number;
  getLine(i: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/** True when one of the bottom WAIT_ROWS rows of the visible screen shows the wait line. */
export function screenWaitsForBackground(buffer: WaitBuffer, rows: number): boolean {
  const bottom = buffer.baseY + rows - 1;
  for (let i = Math.max(buffer.baseY, bottom - WAIT_ROWS + 1); i <= bottom; i++) {
    const text = buffer.getLine(i)?.translateToString(true);
    if (text && matchesBackgroundWait(text)) return true;
  }
  return false;
}

