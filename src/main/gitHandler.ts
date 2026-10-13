// One Git request, end to end: allow-list, validation, folder resolution, the call. No Electron here, so the tests can run it.
import {
  validateGitRequest, type GitChannel, type GitRequestMap, type GitResult,
} from '../shared/git';
import type { Git } from './git';

export const GONE = 'Projekt już nie istnieje.';
const INVALID = 'Nieprawidłowe żądanie git.';

export const GIT_CHANNELS: readonly GitChannel[] = ['status', 'log', 'show', 'diff', 'branches', 'fetch', 'pull', 'push', 'stage', 'unstage', 'commit', 'checkout'];

type Run = (git: Git, dir: string, req: never) => Promise<GitResult<unknown>>;

const RUNNERS: { [C in GitChannel]: (git: Git, dir: string, req: GitRequestMap[C]) => Promise<GitResult<unknown>> } = {
  status: (git, dir) => git.status(dir),
  log: (git, dir, req) => git.log(dir, req),
  show: (git, dir, req) => git.show(dir, req.hash),
  diff: (git, dir, req) => git.diff(dir, req),
  branches: (git, dir) => git.branches(dir),
  fetch: (git, dir, req) => git.fetch(dir, req.requestId),
  pull: (git, dir, req) => git.pull(dir, req.requestId),
  push: (git, dir, req) => git.push(dir, req),
  stage: (git, dir, req) => git.stage(dir, req),
  unstage: (git, dir, req) => git.unstage(dir, req),
  commit: (git, dir, req) => git.commit(dir, req),
  checkout: (git, dir, req) => git.checkout(dir, req),
};

/** One request, end to end (also what the tests call): validates, resolves the folder, runs. */
export async function handleGit(git: Git, projectPath: string | undefined, channel: string, input: unknown, windows: boolean): Promise<GitResult<unknown>> {
  if (!(GIT_CHANNELS as readonly string[]).includes(channel)) return { ok: false, code: 'invalid', error: INVALID };
  const name = channel as GitChannel;
  if (!projectPath) return { ok: false, code: 'gone', error: GONE };
  const checked = validateGitRequest(name, input, windows);
  if (!checked.ok) return { ok: false, code: 'invalid', error: checked.error };
  const request = checked.value as { worktree?: string };
  const dir = await git.resolveDir(projectPath, request.worktree);
  if (!dir.ok) return dir;
  try {
    return await (RUNNERS[name] as unknown as Run)(git, dir.data, request as never);
  } catch (error) {
    return { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
