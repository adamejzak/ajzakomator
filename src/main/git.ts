// The Git panel's engine: the system `git`, started with execFile (never through a shell), always inside a repository folder the caller
// resolved, with timeouts, output caps and a quiet environment (nothing may wait for a terminal). Every argument that comes from the
// renderer was validated by shared/git.ts before it gets here, and the ones that could still look like an option go behind "--" or
// travel on stdin (paths, commit messages).
import { execFile, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { cleanEnv } from '../shared/env';
import { normalizeProjectPath } from '../shared/platform';
import {
  BRANCH_FORMAT, DETAILS_FORMAT, GIT_COMMIT_FILE_LIMIT, GIT_MAX_FILES, LOG_FORMAT, isSafeRef, isSafeRemote, parseBranches, parseDetails,
  parseDiffTree, parseLog, parseStatusV2, parseWorktrees, redactSecrets, trimGitText,
  type GitBranch, type GitCheckoutRequest, type GitCommitDetails, type GitCommitRequest, type GitDiffRequest, type GitDiffResult,
  type GitErrorCode, type GitLogPage, type GitLogRequest, type GitOpResult, type GitPathsRequest, type GitProbe, type GitPushRequest,
  type GitPushTarget, type GitResult, type GitStatus, type GitWorktree,
} from '../shared/git';

export interface GitOptions {
  /** The executable (default "git"); tests point it at a stand-in. */
  bin?: string;
  /** Arguments that go before git's own (a stand-in script). */
  prefixArgs?: string[];
  /** Replaces process.env as the base of the child environment. */
  env?: NodeJS.ProcessEnv;
  /** Local reads (status, log, diff ...). */
  readTimeoutMs?: number;
  /** Operations that talk to a remote, and the ones that run hooks. */
  networkTimeoutMs?: number;
  /** Cap of the output kept from one command. */
  maxOutputBytes?: number;
}

export const READ_TIMEOUT_MS = 10_000;
export const NETWORK_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 4 * 1024 * 1024;
const DIFF_CAP = 1024 * 1024;

const INSTALL_HINT = 'Nie znaleziono polecenia git. Zainstaluj Git (git-scm.com) i uruchom aplikację ponownie.';

class GitFailure extends Error {
  constructor(readonly code: GitErrorCode, message: string) { super(message); }
}

interface RunOptions {
  timeoutMs: number;
  maxBytes?: number;
  input?: string;
  /** Local read: no optional locks, no fsmonitor, no external diff programs. */
  read?: boolean;
  /** Exit codes besides 0 that are an answer, not a failure (diff --no-index exits 1 when there is a difference). */
  okCodes?: number[];
}

interface RunOutput { code: number; stdout: string; stderr: string; truncated: boolean }

const ok = <T>(data: T): GitResult<T> => ({ ok: true, data });
const fail = (code: GitErrorCode, error: string): GitResult<never> => ({ ok: false, code, error });

/** Ends the process and what it started (a credential helper or ssh keeps the pipes open after git itself is gone). */
function killTree(child: ChildProcess): void {
  try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

export class Git {
  private readonly bin: string;
  private readonly prefix: string[];
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly readTimeout: number;
  private readonly networkTimeout: number;
  private readonly cap: number;
  private readonly busy = new Set<string>();
  private readonly seen = new Map<string, number>();
  private readonly roots = new Map<string, { root: string; at: number }>();

  constructor(options: GitOptions = {}) {
    this.bin = options.bin ?? 'git';
    this.prefix = options.prefixArgs ?? [];
    this.baseEnv = options.env ?? process.env;
    this.readTimeout = options.readTimeoutMs ?? READ_TIMEOUT_MS;
    this.networkTimeout = options.networkTimeoutMs ?? NETWORK_TIMEOUT_MS;
    this.cap = options.maxOutputBytes ?? OUTPUT_CAP;
  }

  // ---------- running git ----------

  private env(read: boolean): Record<string, string> {
    const env = cleanEnv(this.baseEnv);
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'never';
    env.GIT_EDITOR = 'true';
    env.GIT_SEQUENCE_EDITOR = 'true';
    env.GIT_MERGE_AUTOEDIT = 'no';
    env.GIT_PAGER = 'cat';
    if (read) env.GIT_OPTIONAL_LOCKS = '0';
    return env;
  }

  private args(args: string[], read: boolean): string[] {
    const global = ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'protocol.ext.allow=never'];
    // A repository can name a program in its config that status would start on its own (core.fsmonitor): not while only looking.
    if (read) global.push('-c', 'core.fsmonitor=false');
    return [...this.prefix, ...global, ...args];
  }

  private run(cwd: string, args: string[], options: RunOptions): Promise<RunOutput> {
    const read = options.read ?? false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); action(); } };
      const child = execFile(this.bin, this.args(args, read), {
        cwd, env: this.env(read), windowsHide: true, encoding: 'utf8', maxBuffer: options.maxBytes ?? this.cap,
      }, (error, stdout, stderr) => {
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');
        if (!error) return finish(() => resolve({ code: 0, stdout: out, stderr: err, truncated: false }));
        const e = error as NodeJS.ErrnoException & { code?: string | number };
        if (e.code === 'ENOENT') return finish(() => reject(new GitFailure('no-git', INSTALL_HINT)));
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return finish(() => resolve({ code: 0, stdout: out, stderr: err, truncated: true }));
        const code = typeof e.code === 'number' ? e.code : -1;
        if (options.okCodes?.includes(code)) return finish(() => resolve({ code, stdout: out, stderr: err, truncated: false }));
        finish(() => reject(new GitFailure('failed', trimGitText(err || out || e.message))));
      });
      const timer = setTimeout(() => finish(() => {
        killTree(child);
        reject(new GitFailure('timeout', 'Git nie odpowiedział w wyznaczonym czasie.'));
      }), options.timeoutMs);
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input ?? '');
    });
  }

  private async attempt<T>(work: () => Promise<GitResult<T>>): Promise<GitResult<T>> {
    try { return await work(); }
    catch (error) {
      if (error instanceof GitFailure) return fail(error.code, error.message);
      return fail('failed', trimGitText(error instanceof Error ? error.message : String(error)));
    }
  }

  /** The repository root of a folder (git's spelling); cached for a few seconds. Throws not-repo / no-git. */
  private async root(dir: string): Promise<string> {
    const cached = this.roots.get(dir);
    if (cached && Date.now() - cached.at < 5000) return cached.root;
    if (!existsSync(dir)) throw new GitFailure('gone', 'Folder już nie istnieje.');
    let out: RunOutput;
    try { out = await this.run(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: this.readTimeout, read: true }); }
    catch (error) {
      if (error instanceof GitFailure && error.code === 'failed' && !/dubious ownership/i.test(error.message)) throw new GitFailure('not-repo', 'To nie jest repozytorium git.');
      throw error;
    }
    const root = out.stdout.trim();
    if (!root) throw new GitFailure('not-repo', 'To nie jest repozytorium git.');
    this.roots.set(dir, { root, at: Date.now() });
    return root;
  }

  // ---------- reads ----------

  async probe(dir: string): Promise<GitProbe> {
    try { await this.root(dir); return 'repo'; }
    catch (error) { return error instanceof GitFailure && error.code === 'no-git' ? 'no-git' : 'no-repo'; }
  }

  worktrees(dir: string): Promise<GitResult<GitWorktree[]>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const out = await this.run(root, ['worktree', 'list', '--porcelain'], { timeoutMs: this.readTimeout, read: true });
      return ok(parseWorktrees(out.stdout));
    });
  }

  /**
   * The folder to run in: the project folder, or one of the repository's worktrees named by the renderer (matched against what
   * git itself lists, so no other folder can be reached this way).
   */
  async resolveDir(projectPath: string, worktree?: string): Promise<GitResult<string>> {
    if (!worktree) return ok(projectPath);
    const list = await this.worktrees(projectPath);
    if (!list.ok) return list;
    const wanted = normalizeProjectPath(worktree);
    const found = list.data.find((w) => normalizeProjectPath(w.path) === wanted);
    return found ? ok(found.path) : fail('invalid', 'To nie jest worktree tego repozytorium.');
  }

  status(dir: string): Promise<GitResult<GitStatus>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const out = await this.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { timeoutMs: this.readTimeout, read: true });
      const parsed = parseStatusV2(out.stdout, GIT_MAX_FILES);
      const push = parsed.branch && !parsed.initial ? await this.pushTarget(root, parsed.branch) : null;
      return ok({ ...parsed, truncated: parsed.truncated || out.truncated, root, push });
    });
  }

  /** Where a push of the branch goes: its upstream, or (without one) the only remote / "origin" with the same name and --set-upstream. */
  private async pushTarget(root: string, branch: string): Promise<GitPushTarget | null> {
    if (!isSafeRef(branch)) return null;
    try {
      const out = await this.run(root, ['for-each-ref', '--format=%(upstream:remotename)%1f%(upstream:remoteref)', `refs/heads/${branch}`], { timeoutMs: this.readTimeout, read: true });
      const [remote = '', ref = ''] = out.stdout.trim().split('\x1f');
      if (isSafeRemote(remote) && ref.startsWith('refs/heads/') && isSafeRef(ref.slice(11))) return { remote, branch: ref.slice(11), setUpstream: false };
      const remotes = (await this.run(root, ['remote'], { timeoutMs: this.readTimeout, read: true })).stdout.split('\n').map((r) => r.trim()).filter(isSafeRemote);
      const chosen = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
      return chosen ? { remote: chosen, branch, setUpstream: true } : null;
    } catch { return null; }
  }

  log(dir: string, req: GitLogRequest): Promise<GitResult<GitLogPage>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const args = ['log', '--decorate=full', '-z', `--format=${LOG_FORMAT}`, `--max-count=${req.count + 1}`, `--skip=${req.skip}`];
      if (req.all) args.push('--all');
      if (req.search) args.push('--fixed-strings', '--regexp-ignore-case', `--grep=${req.search}`);
      if (req.author) args.push('--fixed-strings', '--regexp-ignore-case', `--author=${req.author}`);
      if (req.path) args.push('--', req.path);
      let out: RunOutput;
      try { out = await this.run(root, args, { timeoutMs: this.readTimeout, read: true }); }
      catch (error) {
        // A repository without commits has no HEAD to walk: that is an empty history, not an error.
        if (error instanceof GitFailure && /does not have any commits|unknown revision|bad default revision/i.test(error.message)) return ok({ commits: [], hasMore: false });
        throw error;
      }
      const commits = parseLog(out.stdout);
      return ok({ commits: commits.slice(0, req.count), hasMore: commits.length > req.count });
    });
  }

  private async parentOf(root: string, hash: string): Promise<string | null> {
    try {
      const out = await this.run(root, ['rev-parse', '--verify', '--quiet', `${hash}^1^{commit}`], { timeoutMs: this.readTimeout, read: true });
      return out.stdout.trim() || null;
    } catch { return null; }
  }

  show(dir: string, hash: string): Promise<GitResult<GitCommitDetails>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      let info: RunOutput;
      try { info = await this.run(root, ['show', '-s', '--decorate=full', `--format=${DETAILS_FORMAT}`, hash, '--'], { timeoutMs: this.readTimeout, read: true }); }
      catch (error) { if (error instanceof GitFailure && error.code === 'failed') throw new GitFailure('invalid', 'Nie ma takiego commita.'); throw error; }
      const details = parseDetails(info.stdout);
      if (!details) throw new GitFailure('failed', 'Nie udało się odczytać commita.');
      // A merge is shown against its first parent (diff-tree -m would list the changes against every parent).
      const parent = details.commit.parents.length ? await this.parentOf(root, hash) : null;
      const range = parent ? [parent, hash] : ['--root', hash];
      const tree = await this.run(root, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--raw', '--numstat', '--no-ext-diff', ...range], { timeoutMs: this.readTimeout, read: true });
      const { files, truncated } = parseDiffTree(tree.stdout, GIT_COMMIT_FILE_LIMIT);
      let added = 0;
      let deleted = 0;
      for (const file of files) { added += file.added ?? 0; deleted += file.deleted ?? 0; }
      return ok({ ...details, files, filesTruncated: truncated || tree.truncated, added, deleted });
    });
  }

  diff(dir: string, req: GitDiffRequest): Promise<GitResult<GitDiffResult>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '-U3'];
      let args: string[];
      let okCodes: number[] | undefined;
      if (req.source === 'untracked') {
        args = ['diff', '--no-index', ...flags, '--', '/dev/null', req.path];
        okCodes = [1];
      } else if (req.source === 'commit') {
        const parent = await this.parentOf(root, req.hash!);
        args = ['diff-tree', '-p', '-r', '-M', ...flags, ...(parent ? [parent, req.hash!] : ['--root', req.hash!]), '--', req.path];
        if (req.oldPath) args.push(req.oldPath);
      } else {
        args = ['diff', ...(req.source === 'staged' ? ['--cached'] : []), '-M', ...flags, '--', ...(req.oldPath ? [req.oldPath] : []), req.path];
      }
      const out = await this.run(root, args, { timeoutMs: this.readTimeout, read: true, maxBytes: DIFF_CAP, okCodes });
      return ok({ text: out.stdout, truncated: out.truncated, binary: /^Binary files .* differ$|^GIT binary patch$/m.test(out.stdout) });
    });
  }

  branches(dir: string): Promise<GitResult<GitBranch[]>> {
    return this.attempt(async () => {
      const root = await this.root(dir);
      const out = await this.run(root, ['for-each-ref', '--count=400', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], { timeoutMs: this.readTimeout, read: true });
      const all = parseBranches(out.stdout);
      // A remote branch that already has a local twin is not offered a second time.
      const local = new Set(all.filter((b) => !b.remote).map((b) => b.name));
      return ok(all.filter((b) => !b.remote || !local.has(b.name.slice(b.name.indexOf('/') + 1))));
    });
  }

  // ---------- changes ----------

  /** One mutating operation per repository at a time, and one use per request id (a repeated or replayed request does nothing). */
  private mutate<T>(dir: string, requestId: string, work: (root: string) => Promise<GitResult<T>>): Promise<GitResult<T>> {
    return this.attempt(async () => {
      const now = Date.now();
      for (const [id, at] of this.seen) if (now - at > 10 * 60_000) this.seen.delete(id);
      if (this.seen.has(requestId)) return fail('invalid', 'To żądanie zostało już wykonane.');
      const root = await this.root(dir);
      const key = normalizeProjectPath(root);
      if (this.busy.has(key)) return fail('busy', 'Inna operacja git w tym repozytorium jeszcze trwa.');
      this.seen.set(requestId, now);
      this.busy.add(key);
      try { return await work(root); }
      finally { this.busy.delete(key); this.roots.delete(dir); }
    });
  }

  private opMessage(out: RunOutput, fallback: string): GitOpResult {
    const lines = trimGitText(`${out.stdout}\n${out.stderr}`, 400).split('\n').map((l) => l.trim()).filter((l) => l && !/^(hint|warning):/i.test(l));
    return { message: lines.slice(-2).join(' ') || fallback };
  }

  fetch(dir: string, requestId: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, requestId, async (root) => ok(this.opMessage(await this.run(root, ['fetch'], { timeoutMs: this.networkTimeout }), 'OK')));
  }

  /** Fast-forward only: it never creates a merge commit, never rebases and stops when the branches diverged. */
  pull(dir: string, requestId: string): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, requestId, async (root) => ok(this.opMessage(await this.run(root, ['pull', '--ff-only', '--no-rebase', '--no-edit'], { timeoutMs: this.networkTimeout }), 'OK')));
  }

  /**
   * Pushes the current branch to the target the status showed. The renderer sends the remote and branch it confirmed with the
   * user; they must be exactly what this repository would push to now. Never forced, hooks are not skipped.
   */
  push(dir: string, req: GitPushRequest): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, async (root) => {
      const status = await this.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], { timeoutMs: this.readTimeout, read: true });
      const parsed = parseStatusV2(status.stdout);
      if (!parsed.branch || parsed.initial) return fail('invalid', 'Push wymaga gałęzi z co najmniej jednym commitem.');
      const target = await this.pushTarget(root, parsed.branch);
      if (!target) return fail('invalid', 'Brak zdalnego repozytorium, do którego można wypchnąć tę gałąź.');
      if (target.remote !== req.remote || target.branch !== req.branch) return fail('invalid', 'Cel push zmienił się od ostatniego odświeżenia. Odśwież panel i spróbuj ponownie.');
      const args = ['push', ...(target.setUpstream ? ['--set-upstream'] : []), target.remote, `refs/heads/${parsed.branch}:refs/heads/${target.branch}`];
      return ok(this.opMessage(await this.run(root, args, { timeoutMs: this.networkTimeout }), 'OK'));
    });
  }

  stage(dir: string, req: GitPathsRequest): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, async (root) => {
      const out = req.all
        ? await this.run(root, ['add', '-A'], { timeoutMs: this.readTimeout })
        : await this.run(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { timeoutMs: this.readTimeout, input: req.paths.join('\0') });
      return ok(this.opMessage(out, 'OK'));
    });
  }

  unstage(dir: string, req: GitPathsRequest): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, async (root) => {
      let hasHead = true;
      try { await this.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: this.readTimeout, read: true }); } catch { hasHead = false; }
      // Without a first commit there is no HEAD to restore from: the files only leave the index.
      const base = hasHead ? ['restore', '--staged'] : ['rm', '--cached', '-r', '-q'];
      const out = req.all
        ? await this.run(root, [...base, '--', '.'], { timeoutMs: this.readTimeout })
        : await this.run(root, [...base, '--pathspec-from-file=-', '--pathspec-file-nul'], { timeoutMs: this.readTimeout, input: req.paths.join('\0') });
      return ok(this.opMessage(out, 'OK'));
    });
  }

  /** Commits what is staged. The message goes in on stdin; there is no amend and no way to skip the hooks. */
  commit(dir: string, req: GitCommitRequest): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, async (root) => {
      const staged = await this.run(root, ['diff', '--cached', '--quiet', '--no-ext-diff'], { timeoutMs: this.readTimeout, read: true, okCodes: [1] });
      if (staged.code === 0) return fail('invalid', 'Nic nie jest dodane do commita. Dodaj najpierw pliki.');
      const out = await this.run(root, ['commit', '-F', '-'], { timeoutMs: this.networkTimeout, input: req.message.replace(/\r\n/g, '\n') });
      return ok(this.opMessage(out, 'OK'));
    });
  }

  /** Switches branch, only when nothing tracked is modified; a remote branch gets a local branch that tracks it. */
  checkout(dir: string, req: GitCheckoutRequest): Promise<GitResult<GitOpResult>> {
    return this.mutate(dir, req.requestId, async (root) => {
      const status = await this.run(root, ['status', '--porcelain=v2', '-z', '--untracked-files=no'], { timeoutMs: this.readTimeout, read: true });
      if (parseStatusV2(status.stdout).files.length) return fail('dirty', 'Masz niezatwierdzone zmiany. Zatwierdź je lub odłóż, zanim zmienisz gałąź.');
      const full = `refs/${req.remote ? 'remotes' : 'heads'}/${req.branch}`;
      try { await this.run(root, ['rev-parse', '--verify', '--quiet', `${full}^{commit}`], { timeoutMs: this.readTimeout, read: true }); }
      catch { return fail('invalid', 'Nie ma takiej gałęzi.'); }
      const args = req.remote ? ['switch', '--track', req.branch] : ['switch', req.branch];
      return ok(this.opMessage(await this.run(root, args, { timeoutMs: this.networkTimeout }), 'OK'));
    });
  }
}

export { redactSecrets };
