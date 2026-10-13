// Background loading of cells: which cells start without being opened, in which order, and the pacing scheduler.
// Everything here is pure (clock, timers, idle callback, visibility and the start action are injected), so it is unit tested.
import type { AppState } from './types';

/** `visible`: only what is on screen starts. `project`: the active project's other grids load in the background. `all`: every project's grids do. */
export type BackgroundLoadMode = 'visible' | 'project' | 'all';
export const BACKGROUND_LOAD_MODES: readonly BackgroundLoadMode[] = ['visible', 'project', 'all'];
export const DEFAULT_BACKGROUND_LOAD: BackgroundLoadMode = 'project';

/**
 * Most cells the loader starts automatically per launch, whatever the mode. Cells of the grid on screen never count against it
 * (they start when shown), and the rest start when their grid is opened, as in `visible` mode.
 * Every started cell is a real agent process, so a project with many grids must not start dozens of them unasked.
 */
export const BACKGROUND_MAX_CELLS = 12;

export function normalizeBackgroundLoad(value: unknown): BackgroundLoadMode {
  return BACKGROUND_LOAD_MODES.includes(value as BackgroundLoadMode) ? (value as BackgroundLoadMode) : DEFAULT_BACKGROUND_LOAD;
}

export interface PlanOptions {
  /** Project ids, most recently used first (projects not listed follow in sidebar order). */
  recency?: readonly string[];
  /** Projects whose folder is gone: nothing of theirs starts in the background. */
  skipProjects?: ReadonlySet<string>;
}

/**
 * Cell ids to start in the background, in priority order. Closed (archived) grids are never part of it.
 * The active grid is not special-cased here: its cells start when they are mounted, and the caller drops started ones.
 * Order: the active project's grids (the one after the active grid first, wrapping around), then, for `all`, the other
 * projects by recency, each with its grids in tab order.
 */
export function planBackgroundLoad(state: AppState, mode: BackgroundLoadMode, options: PlanOptions = {}): string[] {
  if (mode === 'visible') return [];
  const out: string[] = [];
  const skip = options.skipProjects;
  const cellsOf = (tabs: AppState['projects'][number]['tabs']) => tabs.flatMap((tab) => tab.cells.map((cell) => cell.id));
  const active = state.projects.find((p) => p.id === state.activeProjectId);
  if (active && !skip?.has(active.id)) {
    const at = Math.max(0, active.tabs.findIndex((t) => t.id === active.activeTabId));
    // The grid after the active one first (the likeliest next click), wrapping around; the active grid, normally started already, last.
    const ordered = [...active.tabs.slice(at + 1), ...active.tabs.slice(0, at + 1)];
    out.push(...cellsOf(ordered));
  }
  if (mode === 'all') {
    const rank = new Map((options.recency ?? []).map((id, i) => [id, i]));
    const others = state.projects
      .map((project, index) => ({ project, index }))
      .filter(({ project }) => project.id !== state.activeProjectId && !skip?.has(project.id))
      .sort((a, b) => (rank.get(a.project.id) ?? Infinity) - (rank.get(b.project.id) ?? Infinity) || a.index - b.index);
    for (const { project } of others) out.push(...cellsOf(project.tabs));
  }
  return out;
}

export interface LoaderTuning {
  /** Cells that may be starting at the same moment. */
  maxInFlight: number;
  /** Minimum gap between two starts, so the machine stays responsive. */
  spacingMs: number;
  /** Poll interval while the user is typing / resizing. */
  busyRetryMs: number;
  /** Quiet time after the last keystroke / resize before a start is allowed. */
  quietMs: number;
  /** Wait before the very first start (the active grid gets the machine first). */
  initialDelayMs: number;
  /** Cells started by the loader in total (see BACKGROUND_MAX_CELLS). */
  maxCells: number;
}

export const DEFAULT_LOADER_TUNING: LoaderTuning = { maxInFlight: 2, spacingMs: 400, busyRetryMs: 400, quietMs: 1200, initialDelayMs: 600, maxCells: BACKGROUND_MAX_CELLS };

export interface LoaderDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Runs `fn` when the browser has nothing better to do (requestIdleCallback); tests call it at once. */
  idle(fn: () => void): void;
  /** The window can be seen (not minimized, not hidden). Hidden windows load nothing; `wake()` resumes. */
  windowVisible(): boolean;
  /** Time of the last keystroke / resize / pointer press (ms, same clock as `now`). */
  lastActivityAt(): number;
  /** Starts one cell. Resolves when the request was handled; `false` = the cell was skipped (not started), which does not count against the cap. */
  start(cellId: string): Promise<boolean | void>;
  /** Whether a cell still needs a start (it was not started meanwhile, still exists). */
  needsStart(cellId: string): boolean;
  /** `capped`: the limit was reached and `total - done` cells wait for their grid to be opened. */
  onProgress?(done: number, total: number, capped: boolean): void;
}

/** Starts queued cells one by one with spacing; pauses while the user is busy or the window is hidden. */
export class BackgroundLoader {
  private queue: string[] = [];
  private done = 0;
  private total = 0;
  private inFlight = 0;
  /** Starts dispatched so far (the cap counts these). */
  private dispatched = 0;
  private lastStartAt = -Infinity;
  private timer: unknown = null;
  private running = false;
  private stopped = false;
  private readonly tuning: LoaderTuning;

  constructor(private readonly deps: LoaderDeps, tuning: Partial<LoaderTuning> = {}) {
    this.tuning = { ...DEFAULT_LOADER_TUNING, ...tuning };
  }

  get progress(): { done: number; total: number } { return { done: this.done, total: this.total }; }
  get pending(): number { return this.capped ? this.inFlight : this.queue.length + this.inFlight; }
  /** The limit of automatic starts was reached and cells are still waiting for their grid to be opened. */
  get capped(): boolean { return this.dispatched >= this.tuning.maxCells && this.queue.length > 0; }

  /** Replaces what waits to start (cells already started or gone are dropped). Counters restart when everything was finished. */
  setQueue(ids: readonly string[]): void {
    if (this.pending === 0 && this.queue.length === 0) { this.done = 0; this.total = 0; }
    this.queue = ids.filter((id) => this.deps.needsStart(id));
    this.total = this.done + this.inFlight + this.queue.length;
    this.report();
    if (this.queue.length && this.running) this.schedule(this.deps.now() - this.lastStartAt >= this.tuning.spacingMs ? 0 : this.tuning.spacingMs);
  }

  /** Something started a cell (the user opened its grid): drop it from the queue and update the progress. */
  refresh(): void {
    this.queue = this.queue.filter((id) => this.deps.needsStart(id));
    this.total = this.done + this.inFlight + this.queue.length;
    this.report();
  }

  /** Begins loading (call once the first window paint and the active grid are done). */
  begin(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.schedule(this.tuning.initialDelayMs);
  }

  /** The window became visible again (or any other reason to look at the queue now). */
  wake(): void {
    if (this.running && this.queue.length) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private report(): void {
    this.deps.onProgress?.(this.done, this.total, this.capped);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => { this.timer = null; this.deps.idle(() => this.tick()); }, ms);
  }

  private tick(): void {
    if (this.stopped || !this.running) return;
    // Drop what no longer needs a start (opened meanwhile, closed).
    this.queue = this.queue.filter((id) => this.deps.needsStart(id));
    this.total = this.done + this.inFlight + this.queue.length;
    if (!this.queue.length || this.dispatched >= this.tuning.maxCells) { this.report(); return; }
    if (!this.deps.windowVisible()) return; // wake() resumes
    if (this.inFlight >= this.tuning.maxInFlight) return; // a finished start reschedules
    const now = this.deps.now();
    if (now - this.deps.lastActivityAt() < this.tuning.quietMs) return this.schedule(this.tuning.busyRetryMs);
    const wait = this.tuning.spacingMs - (now - this.lastStartAt);
    if (wait > 0) return this.schedule(wait);
    const id = this.queue.shift()!;
    this.lastStartAt = now;
    this.dispatched++;
    this.inFlight++;
    this.report();
    const finish = () => {
      this.inFlight--;
      this.done++;
      this.report();
      if (this.queue.length) this.schedule(Math.max(0, this.tuning.spacingMs - (this.deps.now() - this.lastStartAt)));
    };
    let settled = false;
    const once = () => { if (!settled) { settled = true; finish(); } };
    const handled = (result: boolean | void) => { if (result === false) this.dispatched--; once(); };
    try { this.deps.start(id).then(handled, once); } catch { once(); }
    if (this.queue.length && this.inFlight < this.tuning.maxInFlight) this.schedule(this.tuning.spacingMs);
  }
}
