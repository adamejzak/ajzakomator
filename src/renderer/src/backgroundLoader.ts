// Starts the cells of grids that are not on screen, staggered, after the active grid is up (policy: shared/backgroundLoad.ts).
import { BackgroundLoader, planBackgroundLoad } from '../../shared/backgroundLoad';
import { activeProject, activeTab } from '../../shared/state';
import { isStarted, needsBackgroundStart, onCellStart, startCellInBackground } from './actions';
import { getS, getUi, setUi, useStore } from './store';
import { isWindowShown, onWindowShown } from './windowShown';

let loader: BackgroundLoader | null = null;
let lastActivity = -Infinity;
/** Projects in the order they were last active in this session (most recent first); the start order of `all` mode. */
const recency: string[] = [];

const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: 1500 });
  else window.setTimeout(fn, 0);
};

function replan(): void {
  if (!loader) return;
  const s = getS();
  loader.setQueue(planBackgroundLoad(s, s.settings.backgroundLoad, { recency, skipProjects: new Set(Object.keys(getUi().missingPaths)) }));
}

/** Call once after the state is loaded. Loading begins when the active grid's cells were started and the window is idle. */
export function initBackgroundLoader(): void {
  if (loader) return;
  const noteActivity = () => { lastActivity = performance.now(); };
  // Typing, mouse presses (divider drags, clicks) and window resizes keep the loader quiet.
  for (const type of ['keydown', 'pointerdown', 'resize'] as const) window.addEventListener(type, noteActivity, { capture: true, passive: true });
  const instance = new BackgroundLoader({
    now: () => performance.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    idle,
    windowVisible: isWindowShown,
    lastActivityAt: () => lastActivity,
    start: startCellInBackground,
    needsStart: needsBackgroundStart,
    onProgress: (done, total, capped) => {
      // Shown while cells are loading, and after the limit was reached for as long as cells still wait for their grid to be opened.
      const next = instance.pending > 0 || capped ? { done, total, capped } : null;
      const current = getUi().backgroundLoad;
      if (current?.done === next?.done && current?.total === next?.total && current?.capped === next?.capped) return;
      setUi({ backgroundLoad: next });
    },
  });
  loader = instance;
  // A grid opened by the user starts its cells: they leave the queue (and the limit hint) without waiting for a re-plan.
  onCellStart(() => queueMicrotask(() => instance.refresh()));
  document.addEventListener('visibilitychange', () => { if (isWindowShown()) instance.wake(); });
  onWindowShown(() => { if (isWindowShown()) instance.wake(); });

  const first = getS().activeProjectId;
  if (first) recency.push(first);
  let seen = { projects: getS().projects, active: getS().activeProjectId, mode: getS().settings.backgroundLoad, epoch: getUi().epoch, missing: getUi().missingPaths };
  useStore.subscribe((st) => {
    if (st.s.activeProjectId && st.s.activeProjectId !== seen.active) {
      const at = recency.indexOf(st.s.activeProjectId);
      if (at >= 0) recency.splice(at, 1);
      recency.unshift(st.s.activeProjectId);
    }
    const now = { projects: st.s.projects, active: st.s.activeProjectId, mode: st.s.settings.backgroundLoad, epoch: st.ui.epoch, missing: st.ui.missingPaths };
    if (now.projects === seen.projects && now.active === seen.active && now.mode === seen.mode && now.epoch === seen.epoch && now.missing === seen.missing) return;
    seen = now;
    replan();
  });
  replan();

  // The active grid's cells are started by their views as they mount; the background waits for them (bounded), then for an idle moment.
  const activeCells = () => activeTab(activeProject(getS()))?.cells.map((c) => c.id) ?? [];
  const startedAt = performance.now();
  const check = () => {
    if (activeCells().every(isStarted) || performance.now() - startedAt > 5000) { instance.begin(); return; }
    window.setTimeout(check, 100);
  };
  requestAnimationFrame(() => requestAnimationFrame(() => idle(check)));
}
