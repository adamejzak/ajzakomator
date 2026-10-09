import { describe, expect, it } from 'vitest';
import { layoutForCount } from '../src/shared/layout';
import {
  addCell, addProject, addTab, closeTab, defaultState, findCell, moveProject, moveSnippet, normalizeState, removeCell, removeProject,
  restoreTab, updateCell, upsertSnippet,
} from '../src/shared/state';

function withProject() {
  let s = defaultState();
  s = addProject(s, { name: 'bot', path: 'D:\\Projekty\\bot' });
  return { s, p: s.projects[0] };
}

describe('state', () => {
  it('defaultState ships the default profiles', () => {
    const s = defaultState();
    expect(s.profiles.map((p) => p.cli)).toEqual(['claude', 'codex', 'shell']);
    expect(s.projects).toEqual([]);
  });

  it('addProject activates the new project', () => {
    const { s, p } = withProject();
    expect(s.activeProjectId).toBe(p.id);
    expect(p.name).toBe('bot');
  });

  it('addTab creates one cell per area and activates the tab', () => {
    const { s: s0, p } = withProject();
    const s = addTab(s0, p.id, { layout: layoutForCount(4), cells: Array(4).fill({ profileId: 'claude' }) });
    const proj = s.projects[0];
    expect(proj.tabs).toHaveLength(1);
    expect(proj.tabs[0].cells).toHaveLength(4);
    expect(proj.activeTabId).toBe(proj.tabs[0].id);
    expect(new Set(proj.tabs[0].cells.map((c) => c.id)).size).toBe(4);
  });

  it('closeTab archives it with sessions and restoreTab brings it back', () => {
    const { s: s0, p } = withProject();
    let s = addTab(s0, p.id, { layout: layoutForCount(1), cells: [{ profileId: 'claude' }] });
    const tab = s.projects[0].tabs[0];
    s = updateCell(s, tab.cells[0].id, { session: { cli: 'claude', id: 'abc' } });
    s = closeTab(s, p.id, tab.id);
    expect(s.projects[0].tabs).toHaveLength(0);
    expect(s.projects[0].archive[0].cells[0].session).toEqual({ cli: 'claude', id: 'abc' });
    s = restoreTab(s, p.id, s.projects[0].archive[0].id);
    expect(s.projects[0].tabs[0].cells[0].session?.id).toBe('abc');
    expect(s.projects[0].archive).toHaveLength(0);
  });

  it('archive keeps at most 50 tabs', () => {
    let { s, p } = withProject();
    for (let i = 0; i < 55; i++) {
      s = addTab(s, p.id, { layout: layoutForCount(1), cells: [{ profileId: 'shell' }] });
      s = closeTab(s, p.id, s.projects[0].tabs[0].id);
    }
    expect(s.projects[0].archive).toHaveLength(50);
  });

  it('addCell grows the layout and removeCell shrinks it', () => {
    const { s: s0, p } = withProject();
    let s = addTab(s0, p.id, { layout: layoutForCount(4), cells: Array(4).fill({ profileId: 'codex' }) });
    const tabId = s.projects[0].tabs[0].id;
    s = addCell(s, p.id, tabId, 'claude');
    let tab = s.projects[0].tabs[0];
    expect(tab.cells).toHaveLength(5);
    expect(tab.layout).toMatchObject({ cols: 3, rows: 2 });
    s = removeCell(s, p.id, tabId, tab.cells[0].id);
    tab = s.projects[0].tabs[0];
    expect(tab.cells).toHaveLength(4);
    expect(tab.layout.areas).toHaveLength(4);
  });

  it('removing the last cell closes the tab', () => {
    const { s: s0, p } = withProject();
    let s = addTab(s0, p.id, { layout: layoutForCount(1), cells: [{ profileId: 'shell' }] });
    const tab = s.projects[0].tabs[0];
    s = removeCell(s, p.id, tab.id, tab.cells[0].id);
    expect(s.projects[0].tabs).toHaveLength(0);
  });

  it('removeProject activates another project', () => {
    let s = defaultState();
    s = addProject(s, { name: 'a', path: 'A' });
    s = addProject(s, { name: 'b', path: 'B' });
    const b = s.projects[1];
    s = removeProject(s, b.id);
    expect(s.activeProjectId).toBe(s.projects[0].id);
  });

  it('normalizeState folds retired profiles into claude/codex', () => {
    const { s: s0, p } = withProject();
    const old = addTab(s0, p.id, { layout: layoutForCount(2), cells: [{ profileId: 'claude-opus' }, { profileId: 'codex-high' }] });
    const raw = { ...old, profiles: [...old.profiles, { id: 'claude-opus', name: 'Claude Opus', cli: 'claude', args: '--model opus', color: '#fff' }] };
    const s = normalizeState(JSON.parse(JSON.stringify(raw)))!;
    expect(s.profiles.map((x) => x.id)).toEqual(['claude', 'codex', 'shell']);
    expect(s.projects[0].tabs[0].cells.map((c) => c.profileId)).toEqual(['claude', 'codex']);
  });

  it('keeps cell names and startup prompts from the tab input', () => {
    const { s: s0, p } = withProject();
    const s = addTab(s0, p.id, { layout: layoutForCount(1), cells: [{ profileId: 'claude', name: ' backend ', startupPrompt: 'zrób X' }] });
    expect(s.projects[0].tabs[0].cells[0]).toMatchObject({ name: 'backend', startupPrompt: 'zrób X' });
  });

  it('moveSnippet reorders', () => {
    let s = defaultState();
    for (const id of ['a', 'b', 'c']) s = upsertSnippet(s, { id, name: id, text: id, autoSend: false });
    expect(moveSnippet(s, 'c', 'a').snippets.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(moveSnippet(s, 'a', null).snippets.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('moves projects before or after a target in either direction without changing the active project', () => {
    let s = defaultState();
    for (const name of ['a', 'b', 'c']) s = addProject(s, { name, path: name });
    const [a, b, c] = s.projects;
    const names = (state: typeof s) => state.projects.map((p) => p.name);
    expect(names(moveProject(s, a.id, b.id, 'before'))).toEqual(['a', 'b', 'c']);
    expect(names(moveProject(s, a.id, b.id, 'after'))).toEqual(['b', 'a', 'c']);
    expect(names(moveProject(s, c.id, a.id, 'before'))).toEqual(['c', 'a', 'b']);
    expect(names(moveProject(s, c.id, a.id, 'after'))).toEqual(['a', 'c', 'b']);
    const moved = moveProject(s, a.id, null);
    expect(names(moved)).toEqual(['b', 'c', 'a']);
    expect(moved.activeProjectId).toBe(s.activeProjectId);
    expect(moved.projects[2]).toBe(a);
    expect(moveProject(s, b.id, b.id)).toBe(s);
    expect(moveProject(s, b.id, 'missing')).toBe(s);
  });

  it('moves snippets below a target, to the end, and past hidden project snippets', () => {
    let s = defaultState();
    for (const id of ['a', 'hidden', 'b', 'c']) s = upsertSnippet(s, { id, name: id, text: id, autoSend: false, projectId: id === 'hidden' ? 'another-project' : undefined });
    expect(moveSnippet(s, 'a', 'b', 'after').snippets.map((x) => x.id)).toEqual(['hidden', 'b', 'a', 'c']);
    expect(moveSnippet(s, 'c', 'b', 'after').snippets.map((x) => x.id)).toEqual(['a', 'hidden', 'b', 'c']);
    expect(moveSnippet(s, 'a', 'c', 'after').snippets.map((x) => x.id)).toEqual(['hidden', 'b', 'c', 'a']);
    expect(moveSnippet(s, 'c', 'c', 'after')).toBe(s);
  });

  it('findCell locates project/tab/cell', () => {
    const { s: s0, p } = withProject();
    const s = addTab(s0, p.id, { layout: layoutForCount(2), cells: [{ profileId: 'a' }, { profileId: 'b' }] });
    const cell = s.projects[0].tabs[0].cells[1];
    expect(findCell(s, cell.id)?.cell.profileId).toBe('b');
    expect(findCell(s, 'nope')).toBeNull();
  });
});
