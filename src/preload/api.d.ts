import type { HookEvent, HookInfo } from '../shared/status';
import type { CellStatus, StatusReason } from '../shared/status';
import type { CliId, CliStatus, CliStatusMap, InstallMethod } from '../shared/cliStatus';
import type { InstallOptions, InstallRequest, InstallStartResult, InstallState } from '../shared/cliInstall';
import type { AutomationInput, AutomationOperation, McpInfo } from '../shared/automation';
import type { StateEdit, StateSnapshot } from '../shared/stateEdits';
import type { AppPlatform } from '../shared/platform';
import type { ChangelogResult } from '../shared/changelog';
import type { AlertEventId } from '../shared/alerts';
import type { UsageState } from '../shared/usage';
import type { LoginRequest, LoginState, SwapResult } from '../shared/accounts';
import type { ReplaceRequest, ReplaceResult, SearchOptions, SearchResult } from '../shared/search';
import type { AppState, CellSession, Profile, ProjectDirectory, ProjectFilePreview, SessionInfo, UpdateState, Worktree } from '../shared/types';

export type { SessionInfo };

export interface SpawnCellRequest {
  /** Start although the CLI is known to be missing ("Uruchom mimo to"). */
  force?: boolean;
  cellId: string;
  cwd: string;
  cols: number;
  rows: number;
  profile: Profile;
  mode: 'new' | 'resume';
  sessionId?: string;
  sessionConfirmed?: boolean;
  /** First prompt for a new conversation. */
  startupPrompt?: string;
}

export interface McApi {
  platform: AppPlatform;
  loadState(): Promise<AppState>;
  loadSnapshot(): Promise<StateSnapshot>;
  applyStateEdit(edit: StateEdit): Promise<StateSnapshot>;
  getMcpInfo(): Promise<McpInfo>;
  automation<K extends AutomationOperation>(operation: K, input: AutomationInput<K>): Promise<unknown>;
  /** `cliMissing` = the profile's CLI is not installed: nothing was spawned. */
  spawnCell(req: SpawnCellRequest): Promise<{ ok: true } | { ok: false; error: string; cliMissing?: CliId; cliStatus?: CliStatus }>;
  /** Detected Claude Code / Codex binaries (may still be empty while the first scan runs; `cli:changed` follows). */
  cliStatus(): Promise<CliStatusMap>;
  /** Forgets cached results and detects again (one CLI or both). */
  cliRecheck(id?: CliId): Promise<CliStatusMap>;
  /** Opens the official documentation of the CLI (address comes from an allow-list in main). */
  cliOpenDocs(id: CliId): void;
  /** Install methods that can work on this machine, each with the exact command (nothing runs). Null for an unknown CLI. */
  installOptions(cli: CliId): Promise<InstallOptions | null>;
  /** Starts the guided install in a visible terminal; main validates {cli, method} against its allow-list. */
  startInstall(request: InstallRequest): Promise<InstallStartResult>;
  cancelInstall(sessionId: string): void;
  /** The install that is running now (a window opened while it runs attaches to it), or null. */
  installCurrent(): Promise<{ sessionId: string; ptyId: string; cli: CliId; method: InstallMethod; command: string } | null>;
  killCell(cellId: string): void;
  killCellAndWait(cellId: string): Promise<void>;
  /** Binds the freshest unclaimed Codex session in `cwd` to the cell (emits cell:session). */
  bindCodexSession(cellId: string, cwd: string): Promise<string | null>;
  aliveCells(): Promise<string[]>;
  reportCellStatus(cellId: string, status: CellStatus, reason?: StatusReason, hooked?: boolean): void;
  pickFolder(): Promise<string | null>;
  /** Native dialog for an own alert sound; null when cancelled. */
  pickSoundFile(): Promise<string | null>;
  /** Bytes of the saved own sound of an alert event (main reads the path from settings); `data` is null when `knownKey` is still current. */
  loadAlertSound(event: AlertEventId, knownKey?: string): Promise<{ ok: true; key: string; data: Uint8Array | null } | { ok: false }>;
  systemBeep(): void;
  pathExists(path: string): Promise<boolean>;
  listProjectDirectory(projectId: string, relativePath?: string): Promise<ProjectDirectory>;
  readProjectFile(projectId: string, relativePath: string): Promise<ProjectFilePreview>;
  listProjectDirectories(projectId: string): Promise<{ ok: true; paths: string[]; truncated: boolean } | { ok: false; error: string }>;
  searchProject(projectId: string, options: SearchOptions): Promise<SearchResult>;
  replaceInProject(projectId: string, request: ReplaceRequest): Promise<ReplaceResult>;
  writeProjectFile(projectId: string, relativePath: string, text: string, expectedText: string): Promise<{ ok: true } | { ok: false; error: string }>;
  listSessions(projectPath: string): Promise<SessionInfo[]>;
  isGitRepo(path: string): Promise<boolean>;
  createWorktree(projectPath: string, name: string): Promise<Worktree>;
  removeWorktree(projectPath: string, wt: Worktree, deleteBranch: boolean): Promise<void>;
  notify(n: { title: string; body: string; cellId: string }): void;
  openExternal(url: string): void;
  openPath(path: string): void;
  revealPath(path: string): void;
  openInEditor(path: string): void;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): void;
  windowsBuild: number;
  getUpdate(): Promise<UpdateState & { currentVersion: string }>;
  checkUpdates(): Promise<void>;
  installUpdate(): void;
  openReleases(): void;
  getChangelog(force?: boolean): Promise<ChangelogResult>;
  getUsage(): Promise<UsageState>;
  refreshUsage(): Promise<UsageState>;
  startLogin(request: LoginRequest): Promise<{ ok: true; sessionId: string; ptyId: string } | { ok: false; error: string }>;
  cancelLogin(sessionId: string): void;
  removeAccount(id: string): Promise<{ ok: boolean; error?: 'busy' | 'pending' }>;
  makeMainAccount(id: string): Promise<SwapResult>;
  /** True while an interrupted swap is unresolved (swaps are blocked). Also pushed on the 'accounts:swapPending' channel. */
  swapPending(): Promise<boolean>;
  clearSwapPending(): Promise<{ ok: boolean }>;
  on(channel: 'auth:state', cb: (state: LoginState) => void): () => void;
  on(channel: 'install:state', cb: (state: InstallState) => void): () => void;
  on(channel: 'cli:changed', cb: (status: CliStatusMap) => void): () => void;
  on(channel: 'cell:restarted', cb: (cellId: string) => void): () => void;
  on(channel: 'cell:hook', cb: (cellId: string, event: HookEvent, info?: HookInfo) => void): () => void;
  on(channel: 'cell:session', cb: (cellId: string, session: CellSession) => void): () => void;
  on(channel: 'cell:spawnError', cb: (cellId: string, message: string) => void): () => void;
  on(channel: 'focus-cell', cb: (cellId: string) => void): () => void;
  on(channel: 'ptyhost:crashed', cb: () => void): () => void;
  on(channel: 'app:before-quit', cb: () => void): () => void;
  on(channel: 'update:state', cb: (s: UpdateState) => void): () => void;
  on(channel: 'usage:state', cb: (state: UsageState) => void): () => void;
  on(channel: 'accounts:swapPending', cb: (pending: boolean) => void): () => void;
  on(channel: 'state:changed', cb: (snapshot: StateSnapshot) => void): () => void;
  on(channel: 'automation:start-cells', cb: (cellIds: string[]) => void): () => void;
}

declare global {
  interface Window {
    mc: McApi;
  }
}
