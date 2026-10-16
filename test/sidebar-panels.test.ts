import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL, gitPanelReason, panelOpenable, railClick, railFocusTarget, resolvePanelId, visiblePanels, type PanelContext, type PanelDef,
} from '../src/shared/sidebarPanels';
import { defaultState, normalizeState } from '../src/shared/state';

const withProject: PanelContext = { hasProject: true, platform: 'win32' };
const noProject: PanelContext = { hasProject: false, platform: 'win32' };
const defs: PanelDef[] = [
  { id: 'projects' },
  { id: 'files', unavailableReason: (ctx) => (ctx.hasProject ? null : 'Najpierw dodaj projekt') },
  { id: 'git', available: () => false },
  { id: 'ssh', available: (ctx) => ctx.platform !== 'darwin' },
];

describe('sidebar panel registry helpers', () => {
  it('hides tiles of panels that are not available and keeps the order', () => {
    expect(visiblePanels(defs, withProject).map((d) => d.id)).toEqual(['projects', 'files', 'ssh']);
    expect(visiblePanels(defs, { ...withProject, platform: 'darwin' }).map((d) => d.id)).toEqual(['projects', 'files']);
  });

  it('shows a tile that cannot be opened yet but does not open it', () => {
    expect(visiblePanels(defs, noProject).map((d) => d.id)).toContain('files');
    expect(panelOpenable(defs[1], noProject)).toBe(false);
    expect(panelOpenable(defs[1], withProject)).toBe(true);
  });

  it('keeps the old view ids valid and falls back to the default for anything else', () => {
    expect(resolvePanelId(defs, 'projects', withProject)).toBe('projects');
    expect(resolvePanelId(defs, 'files', withProject)).toBe('files');
    expect(resolvePanelId(defs, 'files', noProject)).toBe(DEFAULT_PANEL);
    expect(resolvePanelId(defs, 'git', withProject)).toBe(DEFAULT_PANEL);
    for (const junk of [undefined, null, 5, {}, '', 'Files', '__proto__', 'constructor']) expect(resolvePanelId(defs, junk, withProject)).toBe(DEFAULT_PANEL);
  });

  it('opens a panel on click, folds the open one and reopens when collapsed', () => {
    expect(railClick({ collapsed: false, view: 'projects' }, 'files')).toEqual({ collapsed: false, view: 'files' });
    expect(railClick({ collapsed: false, view: 'files' }, 'files')).toEqual({ collapsed: true, view: 'files' });
    expect(railClick({ collapsed: true, view: 'files' }, 'files')).toEqual({ collapsed: false, view: 'files' });
    expect(railClick({ collapsed: true, view: 'files' }, 'projects')).toEqual({ collapsed: false, view: 'projects' });
  });

  it('a tile that opens a view is never the panel shown on the left (R13)', () => {
    const ctx: PanelContext = { hasProject: true, platform: 'win32' };
    const defs = [{ id: 'projects' }, { id: 'terminal', opensView: true }];
    expect(resolvePanelId(defs, 'terminal', ctx)).toBe(DEFAULT_PANEL);
    expect(visiblePanels(defs, ctx).map((d) => d.id)).toEqual(['projects', 'terminal']);
  });

  it('moves focus along the rail with wrapping and Home/End', () => {
    expect(railFocusTarget(3, 0, 'ArrowDown')).toBe(1);
    expect(railFocusTarget(3, 2, 'ArrowDown')).toBe(0);
    expect(railFocusTarget(3, 0, 'ArrowUp')).toBe(2);
    expect(railFocusTarget(3, 1, 'Home')).toBe(0);
    expect(railFocusTarget(3, 1, 'End')).toBe(2);
    expect(railFocusTarget(3, 1, 'a')).toBeNull();
    expect(railFocusTarget(0, 0, 'ArrowDown')).toBeNull();
  });
});

describe('persisted layout of the left panel', () => {
  it('keeps sidebarCollapsed and the content width, and repairs bad values', () => {
    const state = normalizeState(JSON.parse(JSON.stringify({ ...defaultState(), sidebarCollapsed: true, sidebarWidth: 300 })))!;
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.sidebarWidth).toBe(300);
    const repaired = normalizeState(JSON.parse(JSON.stringify({ ...defaultState(), sidebarCollapsed: 'yes', sidebarWidth: 5000 })))!;
    expect(typeof repaired.sidebarCollapsed).toBe('boolean');
    expect(repaired.sidebarWidth).toBe(480);
  });
});

describe('git and terminal tiles', () => {
  const git: PanelDef = { id: 'git', unavailableReason: gitPanelReason };
  const base: PanelContext = { hasProject: true, platform: 'win32' };

  it('opens Git for every project: without a repository or git the panel itself offers git init / installing Git', () => {
    expect(gitPanelReason({ ...base, git: 'repo' })).toBeNull();
    expect(gitPanelReason({ ...base, git: null })).toBeNull();
    expect(gitPanelReason({ ...base, git: 'no-repo' })).toBeNull();
    expect(gitPanelReason({ ...base, git: 'no-git' })).toBeNull();
    expect(gitPanelReason({ hasProject: false, platform: 'win32', git: 'repo' })).toBe('Najpierw dodaj projekt');
  });

  it('keeps the Git tile openable without a repository, and disabled only without a project', () => {
    const ctx: PanelContext = { ...base, git: 'no-repo' };
    expect(visiblePanels([git], ctx).map((d) => d.id)).toEqual(['git']);
    expect(panelOpenable(git, ctx)).toBe(true);
    expect(resolvePanelId([git], 'git', ctx)).toBe('git');
    const none: PanelContext = { hasProject: false, platform: 'win32' };
    expect(panelOpenable(git, none)).toBe(false);
    expect(resolvePanelId([git], 'git', none)).toBe(DEFAULT_PANEL);
  });

  it('keeps the rail order Projects, Files, Git, SSH and the SSH tile always available', () => {
    const source = readFileSync('src/renderer/src/panelRegistry.tsx', 'utf8');
    const entries = source.split(/\r?\n/).filter((line) => /^\s*\{ id: '/.test(line));
    expect(entries.map((line) => /id: '([a-z]+)'/.exec(line)![1])).toEqual(['projects', 'files', 'git', 'terminal']);
    const terminal = entries.find((line) => line.includes("id: 'terminal'"))!;
    expect(terminal).toContain("label: 'SSH'");
    expect(terminal).not.toContain('unavailableReason');
    expect(terminal).toContain('opensView: true');
    expect(entries.find((line) => line.includes("id: 'git'"))).toContain('unavailableReason: gitPanelReason');
  });
});
