import type { AppState } from './types';

// Decision helpers for following a Claude conversation switch (/resume, /clear) reported by the SessionStart hook.

/** Claude session ids are UUIDs; anything else coming from the local hook endpoint is rejected. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Session stored for a conversation reported by the live CLI: confirmed, so MCP restarts keep working. */
export const followedSession = (id: string) => ({ cli: 'claude' as const, id, confirmed: true });

/** True when the cell's stored session id should be replaced by the one the hook reported. */
export function shouldUpdateCellSession(i: SessionUpdateInput): boolean {
  return i.known && i.isClaude && i.alive && SESSION_ID.test(i.reportedId) && i.currentId !== i.reportedId;
}

/** Project folder plus every distinct worktree folder of its cells (their conversations live there). */
export function sessionSearchPaths(projectPath: string, state: AppState): string[] {
  const paths = [projectPath];
  const project = state.projects.find((p) => p.path === projectPath);
  for (const t of project ? [...project.tabs, ...project.archive] : [])
    for (const c of t.cells) if (c.worktree?.path && !paths.includes(c.worktree.path)) paths.push(c.worktree.path);
  return paths;
}

