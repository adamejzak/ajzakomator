import { describe, expect, it } from 'vitest';
import { layoutForCount } from '../src/shared/layout';
import {
  addCell, addProject, addTab, closeTab, defaultState, findCell, removeCell, removeProject,
  restoreTab, updateCell,
} from '../src/shared/state';

function withProject() {
  let s = defaultState();
  s = addProject(s, { name: 'bot', path: 'D:\\Projekty\\bot' });
  return { s, p: s.projects[0] };
}

describe('state', () => {
  it('defaultState ships the default profiles', () => {
    const s = defaultState();
    expect(s.profiles.map((p) => p.cli)).toEqual(['claude', 'claude', 'codex', 'codex', 'shell']);
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

  it('findCell locates project/tab/cell', () => {
    const { s: s0, p } = withProject();
    const s = addTab(s0, p.id, { layout: layoutForCount(2), cells: [{ profileId: 'a' }, { profileId: 'b' }] });
    const cell = s.projects[0].tabs[0].cells[1];
    expect(findCell(s, cell.id)?.cell.profileId).toBe('b');
    expect(findCell(s, 'nope')).toBeNull();
  });
});
