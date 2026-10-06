// git worktrees for cells that should work in isolation from the rest of the grid.
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { promisify } from 'util';
import type { Worktree } from '../shared/types';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run('git', args, { cwd, windowsHide: true });

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const { stdout } = await git(path, 'rev-parse', '--is-inside-work-tree');
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cell';

/** Creates `<parent>\<repo>-wt-<name>` on new branch `mc/<name>` from HEAD (suffixing on collisions). */
export async function createWorktree(projectPath: string, name: string): Promise<Worktree> {
  const base = basename(projectPath);
  const root = slug(name);
  for (let i = 1; i < 100; i++) {
    const n = i === 1 ? root : `${root}-${i}`;
    const path = join(dirname(projectPath), `${base}-wt-${n}`);
    const branch = `mc/${n}`;
    if (existsSync(path) || (await branchExists(projectPath, branch))) continue;
    await git(projectPath, 'worktree', 'add', '-b', branch, path, 'HEAD');
    return { path, branch };
  }
  throw new Error('Nie udało się znaleźć wolnej nazwy dla worktree');
}

export async function removeWorktree(projectPath: string, wt: Worktree, deleteBranch: boolean): Promise<void> {
  await git(projectPath, 'worktree', 'remove', '--force', wt.path);
  if (deleteBranch) await git(projectPath, 'branch', '-D', wt.branch).catch(() => undefined);
}
