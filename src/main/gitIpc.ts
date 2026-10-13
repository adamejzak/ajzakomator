// IPC of the Git panel: the renderer names a project (never a path) and optionally one of its worktrees; main resolves both and
// validates every request (see gitHandler.ts and shared/git.ts) before git runs.
import { ipcMain } from 'electron';
import { appPlatform } from '../shared/platform';
import type { GitProbe, GitResult } from '../shared/git';
import { Git } from './git';
import { GIT_CHANNELS, GONE, handleGit } from './gitHandler';

export interface GitIpcDeps {
  projectPath(projectId: string): string | undefined;
  /** Worktrees the project's cells use (they may sit anywhere). */
  worktreePaths?(projectId: string): string[];
  git?: Git;
  /** Where the trusted repositories are remembered. */
  trustFile?: string;
}

export function registerGitIpc(deps: GitIpcDeps): void {
  const git = deps.git ?? new Git({ trustFile: deps.trustFile });
  const windows = appPlatform(process.platform) === 'win32';
  ipcMain.handle('git:probe', async (_e, projectId: unknown): Promise<GitProbe> => {
    const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
    return path ? git.probe(path) : 'no-repo';
  });
  ipcMain.handle('git:worktrees', async (_e, projectId: unknown, request: unknown): Promise<GitResult<unknown>> => {
    const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
    if (!path) return { ok: false, code: 'gone', error: GONE };
    const wanted = (request as { prefer?: unknown } | null)?.prefer;
    const prefer = typeof wanted === 'string' && wanted.length > 0 && wanted.length <= 1000 && !wanted.includes('\0') ? wanted : undefined;
    return git.worktrees(path, path, deps.worktreePaths?.(projectId as string) ?? [], prefer);
  });
  for (const channel of GIT_CHANNELS) {
    ipcMain.handle(`git:${channel}`, (_e, projectId: unknown, request: unknown) => {
      const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
      return handleGit(git, path, channel, request, windows, typeof projectId === 'string' ? deps.worktreePaths?.(projectId) ?? [] : []);
    });
  }
}
