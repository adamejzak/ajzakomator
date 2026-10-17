// Status badges of grids and projects, derived from the per-cell statuses as one comparable key: a status flip that leaves
// every count as it was produces the same key, so the tab strip and the project list do not re-render for it.
import { aggregate, type CellStatus, type StatusCounts } from './status';

interface TabLike { id: string; cells: ReadonlyArray<{ id: string }> }
interface ProjectLike { id: string; tabs: ReadonlyArray<TabLike> }

export const NO_COUNTS: StatusCounts = Object.freeze({ working: 0, waiting: 0, exited: 0 });

/** Key of the project entries in the result of statusCountsOf (tab ids are used as they are). */
export const projectCountsKey = (projectId: string): string => `project:${projectId}`;

/** Counts per tab id and per project (projectCountsKey); groups with no working, waiting or exited cell are left out. */
export function statusCountsOf(projects: ReadonlyArray<ProjectLike>, statuses: Readonly<Record<string, CellStatus>>): Record<string, StatusCounts> {
  const out: Record<string, StatusCounts> = {};
  const busy = (c: StatusCounts) => c.working + c.waiting + c.exited > 0;
  for (const p of projects) {
    const all: StatusCounts = { working: 0, waiting: 0, exited: 0 };
    for (const t of p.tabs) {
      const counts = aggregate(t.cells.map((c) => statuses[c.id] ?? 'idle'));
      if (!busy(counts)) continue;
      out[t.id] = counts;
      all.working += counts.working; all.waiting += counts.waiting; all.exited += counts.exited;
    }
    if (busy(all)) out[projectCountsKey(p.id)] = all;
  }
  return out;
}

/** statusCountsOf as a string: equal strings mean equal badges everywhere. */
export const statusCountsKey = (projects: ReadonlyArray<ProjectLike>, statuses: Readonly<Record<string, CellStatus>>): string =>
  JSON.stringify(statusCountsOf(projects, statuses));
