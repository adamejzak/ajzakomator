import type { HookEvent } from '../shared/status';
import type { AppState, CellSession, Profile, SessionInfo, Worktree } from '../shared/types';

export type { SessionInfo };

export interface SpawnCellRequest {
  cellId: string;
  cwd: string;
  cols: number;
  rows: number;
  profile: Profile;
  mode: 'new' | 'resume';
  sessionId?: string;
}

export interface McApi {
  loadState(): Promise<AppState>;
  saveState(state: AppState): void;
  spawnCell(req: SpawnCellRequest): Promise<{ ok: true } | { ok: false; error: string }>;
  killCell(cellId: string): void;
  aliveCells(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  pathExists(path: string): Promise<boolean>;
  listSessions(projectPath: string): Promise<SessionInfo[]>;
  isGitRepo(path: string): Promise<boolean>;
  createWorktree(projectPath: string, name: string): Promise<Worktree>;
  removeWorktree(projectPath: string, wt: Worktree, deleteBranch: boolean): Promise<void>;
  notify(n: { title: string; body: string; cellId: string }): void;
  openPath(path: string): void;
  openInEditor(path: string): void;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): void;
  windowsBuild: number;
  on(channel: 'cell:hook', cb: (cellId: string, event: HookEvent) => void): () => void;
  on(channel: 'cell:session', cb: (cellId: string, session: CellSession) => void): () => void;
  on(channel: 'cell:spawnError', cb: (cellId: string, message: string) => void): () => void;
  on(channel: 'focus-cell', cb: (cellId: string) => void): () => void;
  on(channel: 'ptyhost:crashed', cb: () => void): () => void;
  on(channel: 'app:before-quit', cb: () => void): () => void;
}

declare global {
  interface Window {
    mc: McApi;
  }
}
