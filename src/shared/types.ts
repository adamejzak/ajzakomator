import type { GridLayout } from './layout';
import type { Language } from './languages';

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

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'zsh' | 'bash';

export interface Settings {
  /** null until the language is confirmed on first launch. */
  language: Language | null;
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
  sidebarWidth: number;
  snippetsWidth: number;
}

export interface ProjectFileEntry {
  name: string;
  /** Relative to the project root, with forward slashes. */
  path: string;
  kind: 'directory' | 'file' | 'symlink';
}

export type ProjectDirectory =
  | { ok: true; entries: ProjectFileEntry[]; truncated: boolean }
  | { ok: false; error: string };

export type ProjectFilePreview =
  | { kind: 'text'; text: string; size: number; truncated: boolean }
  | { kind: 'binary'; size: number }
  | { kind: 'error'; message: string };

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
