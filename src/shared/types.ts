import type { GridLayout } from './layout';
import type { Language } from './languages';
import type { AlertSettings } from './alerts';
import type { UpdateMode } from './updateMode';
import type { AgentRole, AutomationState } from './automation';
import type { BackgroundLoadMode } from './backgroundLoad';

export type CliKind = 'claude' | 'codex' | 'shell';

export interface Profile {
  id: string;
  name: string;
  cli: CliKind;
  /** Extra CLI arguments, typed verbatim using the selected shell's syntax. */
  args: string;
  color: string;
}

export interface CellSession {
  cli: 'claude' | 'codex';
  id: string;
  /** Explicitly chosen by the user; transcript timestamp guesses cannot authorize delivery. */
  confirmed?: boolean;
}

export interface Worktree {
  path: string;
  branch: string;
}

export interface Cell {
  id: string;
  profileId: string;
  role?: AgentRole;
  model?: string;
  /** User-given label; without it the header shows the conversation title. */
  name?: string;
  /** Accent color of the cell (header tint + border). */
  color?: string;
  /** Sent to the agent as its first prompt on the next new-conversation start, then cleared. */
  startupPrompt?: string;
  worktree?: Worktree;
  session?: CellSession;
  fontSize?: number;
  /** The user muted this cell's alerts (notification and sound); its status is still shown. */
  muted?: boolean;
}

export interface Tab {
  id: string;
  color?: string;
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
  color?: string;
  profileId: string;
  role?: AgentRole;
  model?: string;
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
  shell: ShellKind;
  lastProfileId: string;
  /** Startup update behaviour (see `UpdateMode`); replaces the former boolean `autoInstallUpdates`. */
  updateMode: UpdateMode;
  /** Show the docked "AI account limits" section in the sidebar. */
  showAiUsage: boolean;
  /** How often the limits are read, in minutes (1, 5 or 15). */
  usageIntervalMinutes: number;
  /** The docked section is folded to one line. */
  usageCollapsed: boolean;
  /** Notifications and sounds for the agent events (finished, needs you, error); replaces the retired `notifications` and `waitingSound*` keys. */
  alerts: AlertSettings;
  /** Which grids start in the background after launch (see shared/backgroundLoad.ts). */
  backgroundLoad: BackgroundLoadMode;
}

export interface AppState {
  version: 1;
  automation: AutomationState;
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
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'unavailable';
  message?: string;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  version?: string;
  percent?: number;
  /** When the last successful check finished (ms since epoch) and the newest version GitHub reported. */
  checkedAt?: number;
  /** Builds without automatic installation (portable Windows, and a macOS app that cannot replace itself) link to downloads. */
  portable?: boolean;
  url?: string;
}
