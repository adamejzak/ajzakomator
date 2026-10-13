import { describe, expect, it } from 'vitest';
import { StateController } from '../src/main/stateController';
import { layoutForCount } from '../src/shared/layout';
import { OptimisticState } from '../src/shared/optimisticState';
import {
  addCell, addProject, addTab, closeTab, defaultState, moveProject, removeCell, removeProject, restoreTab, setActiveProject, swapCells, updateCell, updateProject, updateSettings,
} from '../src/shared/state';
import type { StateEdit, StateSnapshot } from '../src/shared/stateEdits';
import { stateChange, type StateAck, type StateChange } from '../src/shared/statePatch';
import { StateSync } from '../src/shared/stateSync';
import type { AppState } from '../src/shared/types';

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function startState(): AppState {
  let s = defaultState();
  for (let p = 0; p < 2; p++) {
    s = addProject(s, { name: `P${p}`, path: `/tmp/p${p}` });
    for (let t = 0; t < 2; t++) s = addTab(s, s.activeProjectId!, { name: `Grid ${t}`, layout: layoutForCount(3), cells: [{ profileId: 'claude' }, { profileId: 'claude' }, { profileId: 'codex' }] });
  }
  return s;
}

function randomAction(s: AppState, random: () => number): AppState {
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
  const project = pick(s.projects);
  const tabs = project?.tabs ?? [];
  const ids = s.projects.flatMap((p) => p.tabs.flatMap((t) => t.cells.map((c) => c.id)));
  switch (Math.floor(random() * 11)) {
    case 0: return addProject(s, { name: `N${Math.floor(random() * 99)}`, path: '/tmp/x' });
    case 1: return project && s.projects.length > 1 ? removeProject(s, project.id) : s;
    case 2: return project ? addTab(s, project.id, { layout: layoutForCount(2), cells: [{ profileId: 'shell' }] }) : s;
    case 3: return tabs.length ? closeTab(s, project.id, pick(tabs).id) : s;
    case 4: return project?.archive.length ? restoreTab(s, project.id, pick(project.archive).id) : s;
    case 5: return tabs.length && tabs.every((t) => t.cells.length < 8) ? addCell(s, project.id, pick(tabs).id, 'claude') : s;
    case 6: { const tab = tabs.length ? pick(tabs) : null; return tab && tab.cells.length > 1 ? removeCell(s, project.id, tab.id, pick(tab.cells).id) : s; }
    case 7: { const tab = tabs.length ? pick(tabs) : null; return tab && tab.cells.length > 1 ? swapCells(s, project.id, tab.id, tab.cells[0].id, tab.cells[tab.cells.length - 1].id) : s; }
    case 8: return ids.length ? updateCell(s, pick(ids), { color: `#${Math.floor(random() * 0xffffff).toString(16)}` }) : s;
    case 9: return s.projects.length > 1 ? moveProject(s, s.projects[0].id, s.projects[s.projects.length - 1].id, 'after') : project ? setActiveProject(s, project.id) : s;
    default: return updateSettings(s, { fontSize: 8 + Math.floor(random() * 20) });
  }
}

interface Faults { dropPatch: number; dupPatch: number; loseAck: number; failEdit: number }

/** A renderer (StateSync) and main (StateController) connected by an unreliable, interleaved network. */
function world(seed: number, faults: Faults) {
  const random = rng(seed);
  const start = startState();
  let previous = start;
  const toRenderer: StateChange[] = [];
  const requests: Array<{ kind: 'edit'; edit: StateEdit; done: (ack: StateAck | Error | null) => void } | { kind: 'snapshot'; done: (s: StateSnapshot) => void }> = [];
  const replies: Array<() => void> = [];
  let faulty = true;
  const controller = new StateController(clone(start), (snapshot) => {
    const change = clone(stateChange(previous, snapshot));
    previous = snapshot.state;
    if (faulty && random() < faults.dropPatch) return;
    toRenderer.push(change);
    if (faulty && random() < faults.dupPatch) toRenderer.push(clone(change));
  });
  let view: AppState = clone(start);
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sync = new StateSync(clone(controller.snapshot()), {
    transport: {
      applyEdit: (edit) => new Promise<StateAck>((resolve, reject) => {
        requests.push({ kind: 'edit', edit: clone(edit), done: (r) => (r instanceof Error ? reject(r) : r ? resolve(r) : undefined /* the answer is lost */) });
      }),
      loadSnapshot: () => new Promise<StateSnapshot>((resolve) => requests.push({ kind: 'snapshot', done: resolve })),
    },
    setTimer: (fn, ms) => { timers.push({ at: clock + ms, fn }); return timers.length; },
    onState: (s) => { view = s; },
  });
  view = sync.init(clone(controller.snapshot()));

  const step = async (): Promise<void> => {
    const roll = random();
    if (roll < 0.22) { // the user edits what is on screen
      const next = randomAction(view, random);
      if (next !== view) { const edit: StateEdit = { id: `e${Math.floor(random() * 1e9)}`, base: view, next }; view = next; sync.submit(edit); }
    } else if (roll < 0.34) { // MCP / main changes the state on its own
      controller.change((s) => randomAction(s, random));
    } else if (roll < 0.52) { // main handles the next request, in order
      const request = requests.shift();
      if (request?.kind === 'edit') {
        if (faulty && random() < faults.failEdit) replies.push(() => request.done(new Error('transport failed')));
        else {
          try {
            const result = controller.apply(request.edit);
            const ack = { revision: result.revision, editId: result.editId };
            if (faulty && random() < faults.loseAck) replies.push(() => request.done(null));
            else replies.push(() => request.done(ack));
          } catch (error) { replies.push(() => request.done(error as Error)); }
        }
      } else if (request) {
        const snapshot = clone(controller.snapshot());
        replies.push(() => request.done(snapshot));
      }
    } else if (roll < 0.74) { // a patch reaches the renderer
      const change = toRenderer.shift();
      if (change) sync.receive(change);
    } else if (roll < 0.9) { // an answer reaches the renderer
      replies.shift()?.();
    } else { // time passes
      clock += Math.floor(random() * 600);
      for (const t of timers.filter((x) => x.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    }
    await flush();
  };

  const quiet = () => !requests.length && !replies.length && !toRenderer.length && !timers.length && !sync.busy;
  const drain = async () => {
    for (let i = 0; i < 400 && !quiet(); i++) {
      const request = requests.shift();
      if (request?.kind === 'edit') { try { const r = controller.apply(request.edit); request.done({ revision: r.revision, editId: r.editId }); } catch (error) { request.done(error as Error); } }
      else if (request) request.done(clone(controller.snapshot()));
      for (const c of toRenderer.splice(0)) sync.receive(c);
      for (const r of replies.splice(0)) r();
      clock += 1000;
      for (const t of timers.filter((x) => x.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
      await flush();
    }
  };

  return {
    step, drain, sync, controller, faultsOff: () => { faulty = false; }, getView: () => view,
    /** One more reliable change by main: what makes a renderer that missed a patch notice. */
    poke: () => controller.change((s) => updateSettings(s, { fontSize: 8 + Math.floor(random() * 20) })),
  };
}

describe('state sync under faults (lost patches and answers, failed edits, resync in flight)', () => {
  it('ends with the renderer showing exactly main\'s state, and no edit left pending, for hundreds of seeds', async () => {
    const faults: Faults = { dropPatch: 0.2, dupPatch: 0.1, loseAck: 0.15, failEdit: 0.05 };
    for (let seed = 1; seed <= 300; seed++) {
      const w = world(seed, faults);
      for (let i = 0; i < 90; i++) await w.step();
      w.faultsOff();
      await w.drain();
      w.poke();
      await w.drain();
      expect(w.getView(), `seed ${seed}`).toEqual(clone(w.controller.get()));
      expect(w.sync.pendingCount, `seed ${seed} pending`).toBe(0);
      expect(w.sync.revision, `seed ${seed} revision`).toBe(w.controller.snapshot().revision);
    }
  }, 120_000);

  it('also without any fault the renderer follows main step by step', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const w = world(seed, { dropPatch: 0, dupPatch: 0, loseAck: 0, failEdit: 0 });
      for (let i = 0; i < 80; i++) await w.step();
      await w.drain();
      expect(w.getView(), `seed ${seed}`).toEqual(clone(w.controller.get()));
      expect(w.sync.pendingCount).toBe(0);
    }
  }, 60_000);
});

describe('the reviewed scenario: an edit pending across a gap', () => {
  it('after the missed patch and the resync the edit is settled, so the later changes of main show on the screen', async () => {
    let initial = addProject(defaultState(), { name: 'P', path: '/p' });
    initial = addProject(initial, { name: 'Q', path: '/q' });
    const [p, q] = initial.projects;
    const pushes: StateChange[] = [];
    let previous = initial;
    const controller = new StateController(clone(initial), (snapshot) => { pushes.push(clone(stateChange(previous, snapshot))); previous = snapshot.state; });
    let view = clone(initial);
    const sync = new StateSync(clone(controller.snapshot()), {
      transport: {
        applyEdit: async (edit) => { const r = controller.apply(clone(edit)); return { revision: r.revision, editId: r.editId }; },
        loadSnapshot: async () => clone(controller.snapshot()),
      },
      setTimer: () => 0,
      onState: (s) => { view = s; },
    });
    sync.init(clone(controller.snapshot()));
    controller.change((s) => updateSettings(s, { fontSize: 20 })); // revision 1: its patch is lost
    pushes.length = 0;
    const next = updateProject(view, p.id, { color: '#ff0000' });
    const edit: StateEdit = { id: 'E', base: view, next };
    view = next;
    sync.submit(edit); // main applies it as revision 2 and sends a patch that does not follow what the renderer has
    await flush();
    for (const change of pushes.splice(0)) sync.receive(change);
    await flush();
    expect(sync.pendingCount).toBe(0);
    // main removes Q and recolors P: the screen has to follow, with no zombie edit repainting P red
    controller.change((s) => updateProject(removeProject(s, q.id), p.id, { color: '#0000ff' }));
    for (const change of pushes.splice(0)) sync.receive(change);
    await flush();
    expect(view.projects.map((x) => [x.id, x.color])).toEqual([[p.id, '#0000ff']]);
    expect(view).toEqual(clone(controller.get()));
  });
});

describe('OptimisticState acknowledgements', () => {
  const state = () => addProject(defaultState(), { name: 'A', path: '/a' });

  it('drops an edit once the confirmed revision reaches the revision of its ack, also for a duplicated ack', () => {
    const s0 = state();
    const o = new OptimisticState({ state: s0, revision: 1 });
    const next = updateSettings(s0, { fontSize: 21 });
    o.stage({ id: 'x', base: s0, next });
    expect(o.ack('x', 2).behind).toBe(true);
    expect(o.pendingCount).toBe(1);
    o.accept({ state: next, revision: 2 });
    expect(o.pendingCount).toBe(0);
    expect(o.ack('x', 2)).toMatchObject({ dropped: false, behind: false }); // duplicated ack
    expect(o.pendingCount).toBe(0);
  });

  it('an ack whose revision is already confirmed drops the edit at once', () => {
    const s0 = state();
    const o = new OptimisticState({ state: s0, revision: 5 });
    o.stage({ id: 'x', base: s0, next: updateSettings(s0, { fontSize: 22 }) });
    expect(o.ack('x', 4)).toMatchObject({ dropped: true, behind: false });
  });

  it('a snapshot clears the edits sent before it was requested, not the ones sent after', () => {
    const s0 = state();
    const o = new OptimisticState({ state: s0, revision: 1 });
    o.stage({ id: 'early', base: s0, next: updateSettings(s0, { fontSize: 9 }) });
    const covered = o.pendingIds();
    o.stage({ id: 'late', base: s0, next: updateSettings(s0, { fontSize: 10 }) });
    o.acceptSnapshot({ state: updateSettings(s0, { fontSize: 9 }), revision: 2 }, covered);
    expect(o.pendingIds()).toEqual(['late']);
  });

  it('a duplicated or stale patch changes nothing but still settles its edit', () => {
    const s0 = state();
    const s1 = updateSettings(s0, { fontSize: 11 });
    const o = new OptimisticState({ state: s0, revision: 1 });
    const change = stateChange(s0, { state: s1, revision: 2, editId: 'x' });
    o.stage({ id: 'x', base: s0, next: s1 });
    expect(o.acceptChange(change)?.settings.fontSize).toBe(11);
    expect(o.acceptChange(change)?.settings.fontSize).toBe(11); // the duplicate does not ask for a snapshot
    expect(o.revision).toBe(2);
  });
});
