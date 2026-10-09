// Pure state transitions. Every function returns a new AppState and never mutates its input.
import { growLayout, removeArea, type GridLayout } from './layout';
import { DEFAULT_PROFILES, RETIRED_PROFILES } from './profiles';
import { isLanguage } from './languages';
import { defaultShell, shellsForPlatform, type AppPlatform } from './platform';
import { normalizePanelWidth, PANEL_LIMITS } from './panels';
import { defaultAutomation } from './automation';
import type {
  AppState, Cell, Preset, Profile, Project, Settings, Snippet, Tab, Worktree,
} from './types';

export const ARCHIVE_LIMIT = 50;
export const PROJECT_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

export const uid = () => globalThis.crypto.randomUUID();

export function defaultState(platform: AppPlatform = 'win32'): AppState {
  return {
    version: 1,
    automation: defaultAutomation(),
    projects: [],
    activeProjectId: null,
    profiles: DEFAULT_PROFILES.map((p) => ({ ...p, ...(p.cli === 'shell' && platform !== 'win32' ? { name: 'Terminal' } : {}) })),
    presets: [],
    snippets: [],
    settings: { language: null, fontSize: 13, notifications: true, shell: defaultShell(platform), lastProfileId: 'claude' },
    sidebarCollapsed: false,
    snippetsOpen: true,
    sidebarWidth: PANEL_LIMITS.sidebar.default,
    snippetsWidth: PANEL_LIMITS.snippets.default,
  };
}

const mapProject = (s: AppState, projectId: string, fn: (p: Project) => Project): AppState => ({
  ...s,
  projects: s.projects.map((p) => (p.id === projectId ? fn(p) : p)),
});

const mapTab = (s: AppState, projectId: string, tabId: string, fn: (t: Tab) => Tab): AppState =>
  mapProject(s, projectId, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }));

type CellInput = { profileId: string; role?: Cell['role']; name?: string; startupPrompt?: string; worktree?: Worktree; session?: Cell['session'] };

const newCell = (c: CellInput): Cell => ({
  id: uid(),
  profileId: c.profileId,
  ...(c.role ? { role: c.role } : {}),
  ...(c.name?.trim() ? { name: c.name.trim() } : {}),
  ...(c.startupPrompt?.trim() ? { startupPrompt: c.startupPrompt } : {}),
  ...(c.worktree ? { worktree: c.worktree } : {}),
  ...(c.session ? { session: c.session } : {}),
});

// ── projects ────────────────────────────────────────────────────────────────

export function addProject(s: AppState, input: { name: string; path: string }): AppState {
  const project: Project = {
    id: uid(),
    name: input.name,
    path: input.path,
    color: PROJECT_COLORS[s.projects.length % PROJECT_COLORS.length],
    tabs: [],
    archive: [],
    activeTabId: null,
  };
  return { ...s, projects: [...s.projects, project], activeProjectId: project.id };
}

export function updateProject(s: AppState, id: string, patch: Partial<Pick<Project, 'name' | 'path' | 'color' | 'icon'>>): AppState {
  return mapProject(s, id, (p) => {
    const next = { ...p, ...patch };
    if ('icon' in patch && !patch.icon) delete next.icon;
    return next;
  });
}

export function removeProject(s: AppState, id: string): AppState {
  const idx = s.projects.findIndex((p) => p.id === id);
  const projects = s.projects.filter((p) => p.id !== id);
  const activeProjectId =
    s.activeProjectId === id ? (projects[Math.min(idx, projects.length - 1)]?.id ?? null) : s.activeProjectId;
  return { ...s, projects, activeProjectId };
}

export type DropEdge = 'before' | 'after';

function moveRelative<T extends { id: string }>(items: T[], id: string, targetId: string | null, edge: DropEdge): T[] {
  const moving = items.find((item) => item.id === id);
  if (!moving || id === targetId) return items;
  const rest = items.filter((item) => item.id !== id);
  const target = targetId === null ? rest.length : rest.findIndex((item) => item.id === targetId);
  if (target < 0) return items;
  rest.splice(target + (targetId !== null && edge === 'after' ? 1 : 0), 0, moving);
  return rest.every((item, i) => item === items[i]) ? items : rest;
}

export function moveProject(s: AppState, id: string, targetId: string | null, edge: DropEdge = 'before'): AppState {
  const projects = moveRelative(s.projects, id, targetId, edge);
  return projects === s.projects ? s : { ...s, projects };
}

export function setActiveProject(s: AppState, id: string): AppState {
  return s.projects.some((p) => p.id === id) ? { ...s, activeProjectId: id } : s;
}

// ── tabs ────────────────────────────────────────────────────────────────────

export interface NewTabInput {
  name?: string;
  layout: GridLayout;
  cells: CellInput[];
}

export function addTab(s: AppState, projectId: string, input: NewTabInput): AppState {
  const project = s.projects.find((p) => p.id === projectId);
  if (!project) return s;
  const count = input.layout.areas.length;
  const cells = Array.from({ length: count }, (_, i) => {
    const spec = input.cells[i] ?? input.cells[0] ?? { profileId: 'shell' };
    return newCell(spec);
  });
  const tab: Tab = { id: uid(), name: input.name ?? nextTabName(project), layout: input.layout, cells };
  return mapProject(s, projectId, (p) => ({ ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }));
}

function nextTabName(p: Project): string {
  const used = new Set([...p.tabs, ...p.archive].map((t) => t.name));
  for (let i = 1; ; i++) if (!used.has(`Grid ${i}`)) return `Grid ${i}`;
}

export function renameTab(s: AppState, projectId: string, tabId: string, name: string): AppState {
  return mapTab(s, projectId, tabId, (t) => ({ ...t, name }));
}

export function setActiveTab(s: AppState, projectId: string, tabId: string): AppState {
  return mapProject(s, projectId, (p) => ({ ...p, activeTabId: tabId }));
}

export function moveTab(s: AppState, projectId: string, tabId: string, toIndex: number): AppState {
  return mapProject(s, projectId, (p) => {
    const tabs = [...p.tabs];
    const from = tabs.findIndex((t) => t.id === tabId);
    if (from < 0) return p;
    const [t] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(tabs.length, toIndex)), 0, t);
    return { ...p, tabs };
  });
}

export function closeTab(s: AppState, projectId: string, tabId: string): AppState {
  return mapProject(s, projectId, (p) => {
    const idx = p.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return p;
    const tab = p.tabs[idx];
    const tabs = p.tabs.filter((t) => t.id !== tabId);
    const activeTabId = p.activeTabId === tabId ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : p.activeTabId;
    const archive = [{ ...tab, closedAt: Date.now() }, ...p.archive].slice(0, ARCHIVE_LIMIT);
    return { ...p, tabs, activeTabId, archive };
  });
}

export function restoreTab(s: AppState, projectId: string, archivedId: string): AppState {
  return mapProject(s, projectId, (p) => {
    const archived = p.archive.find((t) => t.id === archivedId);
    if (!archived) return p;
    const { closedAt: _closedAt, ...tab } = archived;
    return { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id, archive: p.archive.filter((t) => t.id !== archivedId) };
  });
}

export function deleteArchived(s: AppState, projectId: string, archivedId: string): AppState {
  return mapProject(s, projectId, (p) => ({ ...p, archive: p.archive.filter((t) => t.id !== archivedId) }));
}

// ── cells ───────────────────────────────────────────────────────────────────

export function addCell(
  s: AppState, projectId: string, tabId: string, profileId: string,
  extra: Omit<CellInput, 'profileId'> = {},
): AppState {
  return mapTab(s, projectId, tabId, (t) => {
    const layout = growLayout(t.layout);
    if (!layout) return t;
    return { ...t, layout, cells: [...t.cells, newCell({ profileId, ...extra })] };
  });
}

export function removeCell(s: AppState, projectId: string, tabId: string, cellId: string): AppState {
  const tab = s.projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId);
  if (!tab) return s;
  if (tab.cells.length <= 1) {
    // Closing the last cell closes the whole tab (it stays in the archive).
    return closeTab(s, projectId, tabId);
  }
  return mapTab(s, projectId, tabId, (t) => ({
    ...t,
    layout: removeArea(t.layout),
    cells: t.cells.filter((c) => c.id !== cellId),
  }));
}

export function swapCells(s: AppState, projectId: string, tabId: string, a: string, b: string): AppState {
  return mapTab(s, projectId, tabId, (t) => {
    const i = t.cells.findIndex((c) => c.id === a);
    const j = t.cells.findIndex((c) => c.id === b);
    if (i < 0 || j < 0) return t;
    const cells = [...t.cells];
    [cells[i], cells[j]] = [cells[j], cells[i]];
    return { ...t, cells };
  });
}

export function updateCell(s: AppState, cellId: string, patch: Partial<Omit<Cell, 'id'>>): AppState {
  const found = findCell(s, cellId);
  if (!found) return s;
  return mapTab(s, found.project.id, found.tab.id, (t) => ({
    ...t,
    cells: t.cells.map((c) => {
      if (c.id !== cellId) return c;
      const next: Cell = { ...c, ...patch };
      // `undefined` in the patch means "remove the field".
      for (const k of Object.keys(patch) as Array<keyof typeof patch>) if (patch[k] === undefined) delete next[k];
      return next;
    }),
  }));
}

export function findCell(s: AppState, cellId: string): { project: Project; tab: Tab; cell: Cell } | null {
  for (const project of s.projects)
    for (const tab of project.tabs) {
      const cell = tab.cells.find((c) => c.id === cellId);
      if (cell) return { project, tab, cell };
    }
  return null;
}

// ── library: profiles, presets, snippets, settings ──────────────────────────

const upsert = <T extends { id: string }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

export const upsertProfile = (s: AppState, p: Profile): AppState => ({ ...s, profiles: upsert(s.profiles, p) });
export const removeProfile = (s: AppState, id: string): AppState =>
  s.profiles.length <= 1 ? s : { ...s, profiles: s.profiles.filter((p) => p.id !== id) };
export const upsertPreset = (s: AppState, p: Preset): AppState => ({ ...s, presets: upsert(s.presets, p) });
export const removePreset = (s: AppState, id: string): AppState => ({ ...s, presets: s.presets.filter((p) => p.id !== id) });
export const upsertSnippet = (s: AppState, sn: Snippet): AppState => ({ ...s, snippets: upsert(s.snippets, sn) });
export function moveSnippet(s: AppState, id: string, targetId: string | null, edge: DropEdge = 'before'): AppState {
  const snippets = moveRelative(s.snippets, id, targetId, edge);
  return snippets === s.snippets ? s : { ...s, snippets };
}
export const removeSnippet = (s: AppState, id: string): AppState => ({ ...s, snippets: s.snippets.filter((x) => x.id !== id) });
export const updateSettings = (s: AppState, patch: Partial<Settings>): AppState => ({ ...s, settings: { ...s.settings, ...patch } });

export const getProfile = (s: AppState, id: string): Profile =>
  s.profiles.find((p) => p.id === id) ?? s.profiles.find((p) => p.cli === 'shell') ?? s.profiles[0];

export const activeProject = (s: AppState): Project | null => s.projects.find((p) => p.id === s.activeProjectId) ?? null;
export const activeTab = (p: Project | null): Tab | null => p?.tabs.find((t) => t.id === p.activeTabId) ?? null;

/** Basic shape check for data loaded from disk; fills in fields added in later versions. */
export function normalizeState(raw: unknown, platform: AppPlatform = 'win32'): AppState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AppState>;
  if (r.version !== 1 || !Array.isArray(r.projects)) return null;
  const d = defaultState(platform);
  const remap = (id: string) => RETIRED_PROFILES[id] ?? id;
  const remapCells = <T extends { profileId: string }>(cells: T[]) => cells.map((c) => ({ ...c, profileId: remap(c.profileId) }));
  const profiles = (Array.isArray(r.profiles) && r.profiles.length ? r.profiles : d.profiles).filter((p) => !(p.id in RETIRED_PROFILES));
  return {
    ...d,
    ...r,
    automation: {
      paused: r.automation?.paused === true,
      tasks: Array.isArray(r.automation?.tasks) ? r.automation.tasks : [],
      messages: Array.isArray(r.automation?.messages) ? r.automation.messages : [],
      events: Array.isArray(r.automation?.events) ? r.automation.events.slice(-200) : [],
    },
    sidebarWidth: normalizePanelWidth(r.sidebarWidth, 'sidebar'),
    snippetsWidth: normalizePanelWidth(r.snippetsWidth, 'snippets'),
    profiles: profiles.length ? profiles : d.profiles,
    presets: (Array.isArray(r.presets) ? r.presets : []).map((p) => ({ ...p, cells: remapCells(p.cells ?? []) })),
    snippets: Array.isArray(r.snippets) ? r.snippets : [],
    settings: {
      ...d.settings, ...(r.settings ?? {}),
      // Existing Polish installations keep their UI and do not get first-run onboarding again.
      language: r.settings?.language === undefined ? 'pl' : isLanguage(r.settings.language) ? r.settings.language : null,
      shell: shellsForPlatform(platform).some((shell) => shell.code === r.settings?.shell) ? r.settings!.shell! : d.settings.shell,
      lastProfileId: remap(r.settings?.lastProfileId ?? d.settings.lastProfileId),
    },
    projects: r.projects.map((p) => ({
      ...p,
      tabs: (p.tabs ?? []).map((t) => ({ ...t, cells: remapCells(t.cells) })),
      archive: (p.archive ?? []).map((t) => ({ ...t, cells: remapCells(t.cells) })),
    })),
  } as AppState;
}

