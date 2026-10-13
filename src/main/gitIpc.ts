// IPC of the Git panel: the renderer names a project (never a path) and optionally one of its worktrees; main resolves both and
// validates every request (see gitHandler.ts and shared/git.ts) before git runs.
import { ipcMain } from 'electron';
import { appPlatform } from '../shared/platform';
import type { GitProbe, GitResult } from '../shared/git';
import { Git } from './git';
import { GIT_CHANNELS, GONE, handleGit } from './gitHandler';

export interface GitIpcDeps {
  projectPath(projectId: string): string | undefined;
  git?: Git;
}

export function registerGitIpc(deps: GitIpcDeps): void {
  const git = deps.git ?? new Git();
  const windows = appPlatform(process.platform) === 'win32';
  ipcMain.handle('git:probe', async (_e, projectId: unknown): Promise<GitProbe> => {
    const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
    return path ? git.probe(path) : 'no-repo';
  });
  ipcMain.handle('git:worktrees', async (_e, projectId: unknown): Promise<GitResult<unknown>> => {
    const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
    return path ? git.worktrees(path) : { ok: false, code: 'gone', error: GONE };
  });
  for (const channel of GIT_CHANNELS) {
    ipcMain.handle(`git:${channel}`, (_e, projectId: unknown, request: unknown) => {
      const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
      return handleGit(git, path, channel, request, windows);
    });
  }
}
