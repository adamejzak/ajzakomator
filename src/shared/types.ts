import type { GridLayout } from './layout';

export type CliKind = 'claude' | 'codex' | 'shell';

export interface Profile {
  id: string;
  name: string;
  cli: CliKind;
  /** Extra CLI arguments, typed verbatim after the command (PowerShell syntax). */
  args: string;
  color: string;
}

export interface CellSession {
  cli: 'claude' | 'codex';
  id: string;
}

export interface Worktree {
  path: string;
  branch: string;
}

export interface Cell {
  id: string;
  profileId: string;
  /** User-given label; without it the header shows the conversation title. */
  name?: string;
  /** Accent color of the cell (header tint + border). */
  color?: string;
  /** Sent to the agent as its first prompt on the next new-conversation start, then cleared. */
  startupPrompt?: string;
  worktree?: Worktree;
  session?: CellSession;
  fontSize?: number;
}

export interface Tab {
  id: string;
  name: string;
  layout: GridLayout;
  cells: Cell[];
}

export interface ArchivedTab extends Tab {
  closedAt: number;
}

export type ProjectIcon = { kind: 'emoji'; value: string } | { kind: 'image'; dataUrl: string };

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  icon?: ProjectIcon;
  tabs: Tab[];
  archive: ArchivedTab[];
  activeTabId: string | null;
}

export interface PresetCell {
  profileId: string;
  worktree: boolean;
  name?: string;
  prompt?: string;
}

export interface Preset {
  id: string;
  name: string;
  layout: GridLayout;
  cells: PresetCell[];
  projectId?: string;
}

export interface Snippet {
  id: string;
  name: string;
  text: string;
  autoSend: boolean;
  icon?: string;
  color?: string;
  projectId?: string;
}

export type ShellKind = 'pwsh' | 'powershell' | 'cmd';

export interface Settings {
  fontSize: number;
  notifications: boolean;
  shell: ShellKind;
  lastProfileId: string;
}

export interface AppState {
  version: 1;
  projects: Project[];
  activeProjectId: string | null;
  profiles: Profile[];
  presets: Preset[];
  snippets: Snippet[];
  settings: Settings;
  sidebarCollapsed: boolean;
  snippetsOpen: boolean;
}

export interface SessionInfo {
  cli: 'claude' | 'codex';
  id: string;
  cwd: string;
  title: string;
  startedAt: number;
  updatedAt: number;
}

export interface UpdateState {
  status: 'idle' | 'available' | 'downloading' | 'ready';
  version?: string;
  percent?: number;
  /** Portable builds can't self-update: they only link to the download page. */
  portable?: boolean;
  url?: string;
}
