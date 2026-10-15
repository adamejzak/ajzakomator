// IPC of the Git panel: the renderer names a project (never a path) and optionally one of its worktrees; main resolves both and
// validates every request (see gitHandler.ts and shared/git.ts) before git runs.
import { ipcMain, shell } from 'electron';
import { execFile } from 'child_process';
import { appPlatform } from '../shared/platform';
import type { GitProbe, GitResult } from '../shared/git';
import { Git } from './git';
import { GIT_CHANNELS, GONE, handleGit } from './gitHandler';
import { listGithub } from './github';
import type { GithubKind, GithubResult } from '../shared/github';

export interface GitIpcDeps {
  projectPath(projectId: string): string | undefined;
  /** Worktrees the project's cells use (they may sit anywhere). */
  worktreePaths?(projectId: string): string[];
  git?: Git;
  /** Where the trusted repositories are remembered. */
  trustFile?: string;
}

const GIT_DOWNLOAD = 'https://git-scm.com/downloads';

const run = (file: string, args: string[], options: { cwd?: string; timeout: number }): Promise<{ ok: true; out: string } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { ...options, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, error: (stderr || stdout || error.message).toString().trim().split('\n').slice(-3).join(' ') || error.message });
      else resolve({ ok: true, out: stdout.toString() });
    });
  });

export function registerGitIpc(deps: GitIpcDeps): void {
  const git = deps.git ?? new Git({ trustFile: deps.trustFile });
  const windows = appPlatform(process.platform) === 'win32';
  ipcMain.handle('git:probe', async (_e, projectId: unknown): Promise<GitProbe> => {
    const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
    return path ? git.probe(path) : 'no-repo';
  });
  /** "This is not a repository yet": `git init` in the project folder (main branch), only when it really is not one. */
  ipcMain.handle('git:init', async (_e, projectId: unknown): Promise<GitResult<{ message: string }>> => {
    const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
    if (!path) return { ok: false, code: 'gone', error: GONE };
    if (await git.probe(path) !== 'no-repo') return { ok: false, code: 'failed', error: 'Ten folder jest już repozytorium git lub git nie jest zainstalowany.' };
    let result = await run('git', ['init', '-b', 'main'], { cwd: path, timeout: 20000 });
    if (!result.ok) result = await run('git', ['init'], { cwd: path, timeout: 20000 });
    return result.ok ? { ok: true, data: { message: result.out.trim() } } : { ok: false, code: 'failed', error: result.error };
  });
  /** Installs Git where the system has a package manager we can drive (winget on Windows, the Xcode tools on macOS); elsewhere the download page opens. */
  ipcMain.handle('git:installGit', async (): Promise<GitResult<{ message: string; restart: boolean }>> => {
    if (windows) {
      const result = await run('winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { timeout: 15 * 60 * 1000 });
      if (result.ok) return { ok: true, data: { message: 'Git zainstalowany.', restart: true } };
      void shell.openExternal(GIT_DOWNLOAD);
      return { ok: false, code: 'failed', error: result.error };
    }
    if (process.platform === 'darwin') {
      const result = await run('xcode-select', ['--install'], { timeout: 30000 });
      return result.ok ? { ok: true, data: { message: 'Instalator narzędzi Xcode (z Gitem) został uruchomiony.', restart: true } } : { ok: false, code: 'failed', error: result.error };
    }
    void shell.openExternal(GIT_DOWNLOAD);
    return { ok: true, data: { message: 'Otwarto stronę pobierania Gita.', restart: false } };
  });
  ipcMain.handle('github:list', async (_e, projectId: unknown, kind: unknown): Promise<GithubResult> => {
    const path = typeof projectId === 'string' ? deps.projectPath(projectId) : undefined;
    if (!path) return { ok: false, code: 'failed', error: GONE };
    return listGithub(path, (kind === 'issues' ? 'issues' : 'pulls') as GithubKind);
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
