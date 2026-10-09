import type { HookEvent } from '../shared/status';
import type { AppPlatform } from '../shared/platform';
import type { AppState, CellSession, Profile, ProjectDirectory, ProjectFilePreview, SessionInfo, UpdateState, Worktree } from '../shared/types';

export type { SessionInfo };

export interface SpawnCellRequest {
  cellId: string;
  cwd: string;
  cols: number;
  rows: number;
  profile: Profile;
  mode: 'new' | 'resume';
  sessionId?: string;
  /** First prompt for a new conversation. */
  startupPrompt?: string;
}

export interface McApi {
  platform: AppPlatform;
  loadState(): Promise<AppState>;
  saveState(state: AppState): void;
  spawnCell(req: SpawnCellRequest): Promise<{ ok: true } | { ok: false; error: string }>;
  killCell(cellId: string): void;
  killCellAndWait(cellId: string): Promise<void>;
  /** Binds the freshest unclaimed Codex session in `cwd` to the cell (emits cell:session). */
  bindCodexSession(cellId: string, cwd: string): Promise<string | null>;
  aliveCells(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  pathExists(path: string): Promise<boolean>;
  listProjectDirectory(projectId: string, relativePath?: string): Promise<ProjectDirectory>;
  readProjectFile(projectId: string, relativePath: string): Promise<ProjectFilePreview>;
  listSessions(projectPath: string): Promise<SessionInfo[]>;
  isGitRepo(path: string): Promise<boolean>;
  createWorktree(projectPath: string, name: string): Promise<Worktree>;
  removeWorktree(projectPath: string, wt: Worktree, deleteBranch: boolean): Promise<void>;
  notify(n: { title: string; body: string; cellId: string }): void;
  openPath(path: string): void;
  revealPath(path: string): void;
  openInEditor(path: string): void;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): void;
  windowsBuild: number;
  getUpdate(): Promise<UpdateState & { currentVersion: string }>;
  installUpdate(): void;
  openReleases(): void;
  on(channel: 'cell:hook', cb: (cellId: string, event: HookEvent) => void): () => void;
  on(channel: 'cell:session', cb: (cellId: string, session: CellSession) => void): () => void;
  on(channel: 'cell:spawnError', cb: (cellId: string, message: string) => void): () => void;
  on(channel: 'focus-cell', cb: (cellId: string) => void): () => void;
  on(channel: 'ptyhost:crashed', cb: () => void): () => void;
  on(channel: 'app:before-quit', cb: () => void): () => void;
  on(channel: 'update:state', cb: (s: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    mc: McApi;
  }
}
