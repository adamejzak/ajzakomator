import { describe, expect, it } from 'vitest';
import { BackgroundLoader, normalizeBackgroundLoad, planBackgroundLoad, type LoaderDeps } from '../src/shared/backgroundLoad';
import { defaultState, normalizeState } from '../src/shared/state';
import type { AppState, Project } from '../src/shared/types';

const layout = { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] };
const cell = (id: string) => ({ id, profileId: 'claude' });
const project = (id: string, tabs: Array<[string, string[]]>, activeTab = tabs[0]?.[0] ?? null): Project => ({
  id, name: id, path: `/${id}`, color: '#fff', archive: [], activeTabId: activeTab,
  tabs: tabs.map(([tabId, cells]) => ({ id: tabId, name: tabId, layout, cells: cells.map(cell) })),
});
const stateOf = (projects: Project[], active: string | null): AppState => ({ ...defaultState(), projects, activeProjectId: active });

describe('background load policy', () => {
  const s = stateOf([
    project('p1', [['t1', ['a1', 'a2']], ['t2', ['b1']], ['t3', ['c1']]], 't2'),
    project('p2', [['t1', ['d1']]]),
    project('p3', [['t1', ['e1']]]),
  ], 'p1');

  it('visible mode loads nothing', () => {
    expect(planBackgroundLoad(s, 'visible')).toEqual([]);
  });

  it('project mode loads only the active project, starting after the active grid, wrapping around, the active grid last', () => {
    expect(planBackgroundLoad(s, 'project')).toEqual(['c1', 'a1', 'a2', 'b1']);
  });

  it('all mode adds the other projects by recency, then sidebar order', () => {
    expect(planBackgroundLoad(s, 'all', { recency: ['p3'] })).toEqual(['c1', 'a1', 'a2', 'b1', 'e1', 'd1']);
    expect(planBackgroundLoad(s, 'all')).toEqual(['c1', 'a1', 'a2', 'b1', 'd1', 'e1']);
  });

  it('never plans archived grids and skips projects whose folder is missing', () => {
    const withArchive = stateOf([
      { ...project('p1', [['t1', ['a1']]]), archive: [{ ...project('x', [['old', ['gone']]]).tabs[0], closedAt: 1 }] },
      project('p2', [['t1', ['d1']]]),
    ], 'p1');
    expect(planBackgroundLoad(withArchive, 'all')).toEqual(['a1', 'd1']);
    expect(planBackgroundLoad(withArchive, 'all', { skipProjects: new Set(['p2']) })).toEqual(['a1']);
    expect(planBackgroundLoad(withArchive, 'all', { skipProjects: new Set(['p1']) })).toEqual(['d1']);
  });

  it('copes with no active project and projects without grids', () => {
    expect(planBackgroundLoad(stateOf([project('p1', [])], null), 'all')).toEqual([]);
    expect(planBackgroundLoad(stateOf([project('p1', [])], 'p1'), 'project')).toEqual([]);
  });
});

describe('background load setting', () => {
  it('defaults to project and keeps valid values', () => {
    expect(defaultState().settings.backgroundLoad).toBe('project');
    expect(normalizeBackgroundLoad(undefined)).toBe('project');
    expect(normalizeBackgroundLoad('weird')).toBe('project');
    expect(normalizeBackgroundLoad(3)).toBe('project');
    for (const mode of ['visible', 'project', 'all'] as const) expect(normalizeBackgroundLoad(mode)).toBe(mode);
  });

  it('migrates saved settings: missing or invalid becomes the default, valid is kept', () => {
    const fresh = defaultState();
    const { backgroundLoad: _drop, ...older } = fresh.settings;
    expect(normalizeState({ ...fresh, settings: older })!.settings.backgroundLoad).toBe('project');
    expect(normalizeState({ ...fresh, settings: { ...older, backgroundLoad: 'nope' } })!.settings.backgroundLoad).toBe('project');
    expect(normalizeState({ ...fresh, settings: { ...older, backgroundLoad: 'all' } })!.settings.backgroundLoad).toBe('all');
    expect(normalizeState({ ...fresh, settings: { ...older, backgroundLoad: 'visible' } })!.settings.backgroundLoad).toBe('visible');
  });
});

/** Deterministic clock: timers fire in order while time is advanced; `idle` runs at once. */
function harness(options: { visible?: boolean; started?: Set<string>; startDelay?: number } = {}) {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const state = { visible: options.visible ?? true, activity: -Infinity, started: options.started ?? new Set<string>(), gone: new Set<string>() };
  const startLog: Array<{ id: string; at: number }> = [];
  const progress: Array<[number, number]> = [];
  const finishers: Array<() => void> = [];
  const deps: LoaderDeps = {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
    idle: (fn) => fn(),
    windowVisible: () => state.visible,
    lastActivityAt: () => state.activity,
    needsStart: (id) => !state.started.has(id) && !state.gone.has(id),
    start: (id) => {
      state.started.add(id);
      startLog.push({ id, at: t });
      if (!options.startDelay) return Promise.resolve();
      return new Promise<void>((resolve) => finishers.push(resolve));
    },
    onProgress: (done, total) => progress.push([done, total]),
  };
  const advance = async (ms: number) => {
    const end = t + ms;
    await Promise.resolve(); await Promise.resolve();
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
      await Promise.resolve(); await Promise.resolve();
    }
    t = end;
    await Promise.resolve(); await Promise.resolve();
  };
  return { deps, state, startLog, progress, advance, finishers, now: () => t };
}

describe('BackgroundLoader scheduling', () => {
  it('waits for the initial delay and then starts cells one at a time with spacing', async () => {
    const h = harness();
    const loader = new BackgroundLoader(h.deps, { spacingMs: 400, initialDelayMs: 500 });
    loader.setQueue(['a', 'b', 'c']);
    loader.begin();
    await h.advance(499);
    expect(h.startLog).toEqual([]);
    await h.advance(2000);
    expect(h.startLog.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    const gaps = h.startLog.slice(1).map((s, i) => s.at - h.startLog[i].at);
    expect(gaps.every((g) => g >= 400)).toBe(true);
    expect(h.startLog[0].at).toBeGreaterThanOrEqual(500);
  });

  it('keeps at most maxInFlight starts running', async () => {
    const h = harness({ startDelay: 1 });
    const loader = new BackgroundLoader(h.deps, { spacingMs: 100, initialDelayMs: 0, maxInFlight: 2 });
    loader.setQueue(['a', 'b', 'c', 'd']);
    loader.begin();
    await h.advance(1000);
    expect(h.startLog.map((s) => s.id)).toEqual(['a', 'b']);
    h.finishers.shift()!();
    await h.advance(500);
    expect(h.startLog.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(loader.progress).toEqual({ done: 1, total: 4 });
  });

  it('pauses while the user is typing or resizing and resumes after the quiet time', async () => {
    const h = harness();
    const loader = new BackgroundLoader(h.deps, { spacingMs: 100, initialDelayMs: 0, quietMs: 1000, busyRetryMs: 200 });
    loader.setQueue(['a', 'b']);
    h.state.activity = 0;
    loader.begin();
    await h.advance(900);
    expect(h.startLog).toEqual([]);
    h.state.activity = 800; // still typing
    await h.advance(800);
    expect(h.startLog).toEqual([]);
    await h.advance(1500);
    expect(h.startLog.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('does nothing while the window is hidden and continues on wake()', async () => {
    const h = harness({ visible: false });
    const loader = new BackgroundLoader(h.deps, { spacingMs: 100, initialDelayMs: 0 });
    loader.setQueue(['a', 'b']);
    loader.begin();
    await h.advance(5000);
    expect(h.startLog).toEqual([]);
    h.state.visible = true;
    loader.wake();
    await h.advance(1000);
    expect(h.startLog.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('skips cells that were opened (started) or closed meanwhile and never starts them twice', async () => {
    const h = harness();
    const loader = new BackgroundLoader(h.deps, { spacingMs: 100, initialDelayMs: 300 });
    loader.setQueue(['a', 'b', 'c', 'd']);
    loader.begin();
    h.state.started.add('a'); // the user opened it
    h.state.gone.add('c'); // its grid was closed
    await h.advance(3000);
    expect(h.startLog.map((s) => s.id)).toEqual(['b', 'd']);
    expect(loader.progress).toEqual({ done: 2, total: 2 });
  });

  it('re-plans: setQueue replaces what waits, keeps the running tally and ends idle', async () => {
    const h = harness();
    const loader = new BackgroundLoader(h.deps, { spacingMs: 100, initialDelayMs: 0 });
    loader.setQueue(['a', 'b']);
    loader.begin();
    await h.advance(1000);
    expect(loader.pending).toBe(0);
    loader.setQueue(['c']);
    expect(loader.progress).toEqual({ done: 0, total: 1 });
    await h.advance(1000);
    expect(h.startLog.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(h.progress.at(-1)).toEqual([1, 1]);
  });

  it('counts a failing start as handled and keeps going', async () => {
    const h = harness();
    const failing = { ...h.deps, start: (id: string) => { h.state.started.add(id); h.startLog.push({ id, at: h.now() }); return id === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve(); } };
    const loader = new BackgroundLoader(failing, { spacingMs: 100, initialDelayMs: 0 });
    loader.setQueue(['a', 'b']);
    loader.begin();
    await h.advance(1000);
    expect(h.startLog.map((s) => s.id)).toEqual(['a', 'b']);
    expect(loader.progress).toEqual({ done: 2, total: 2 });
  });

  it('stop() cancels everything', async () => {
    const h = harness();
    const loader = new BackgroundLoader(h.deps, { spacingMs: 100, initialDelayMs: 0 });
    loader.setQueue(['a', 'b']);
    loader.begin();
    loader.stop();
    await h.advance(2000);
    expect(h.startLog).toEqual([]);
  });
});
