// Decision helpers for following a Claude conversation switch (/resume, /clear) reported by the SessionStart hook.

/** Claude session ids are UUIDs; anything else coming from the local hook endpoint is rejected. */
export const SESSION_ID = /^[A-Za-z0-9_-]{8,100}$/;

export interface SessionUpdateInput {
  /** The cell exists in the persisted state. */
  known: boolean;
  /** The cell's profile runs Claude. */
  isClaude: boolean;
  /** The cell's process is currently running (a late hook from an old process must not win). */
  alive: boolean;
  /** Session id stored on the cell, if any. */
  currentId: string | undefined;
  reportedId: string;
}

/** True when the cell's stored session id should be replaced by the one the hook reported. */
export function shouldUpdateCellSession(i: SessionUpdateInput): boolean {
  return i.known && i.isClaude && i.alive && SESSION_ID.test(i.reportedId) && i.currentId !== i.reportedId;
}
