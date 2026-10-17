// The Git panel's engine against REAL repositories in temporary folders (no mocks of git itself).
import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Git } from '../src/main/git';
import { samePath } from '../src/main/gitPaths';
import { handleGit } from '../src/main/gitHandler';
import type { GitCommitDetails, GitLogPage, GitStatus } from '../src/shared/git';

// Real git processes: slow under a busy machine or CI runner, so these tests get more time than the 20 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let lab: string;
let env: NodeJS.ProcessEnv;
let git: Git;
let counter = 0;
const id = () => `req-${String(++counter).padStart(6, '0')}-xxxx`;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
const write = (dir: string, name: string, text: string) => writeFileSync(join(dir, name), text);

/** A repository with `commits` commits on main. */
function repo(name: string, commits = 3): string {
  const dir = join(lab, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main', '.');
  for (let i = 1; i <= commits; i++) {
    write(dir, 'file.txt', `line ${i}\n`);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', `commit ${i}`);
  }
  return dir;
}

/** A bare remote plus a clone of it (both with a first commit pushed). */
function remotePair(name: string): { bare: string; clone: string; other: string } {
  const bare = join(lab, `${name}.git`);
  sh(lab, 'init', '-q', '--bare', '-b', 'main', bare);
  const clone = join(lab, `${name}-a`);
  sh(lab, 'clone', '-q', bare, clone);
  write(clone, 'a.txt', 'one\n');
  sh(clone, 'add', '.');
  sh(clone, 'commit', '-q', '-m', 'first');
  sh(clone, 'push', '-q', 'origin', 'main');
  const other = join(lab, `${name}-b`);
  sh(lab, 'clone', '-q', bare, other);
  return { bare, clone, other };
}

/** A push request for what the panel would confirm now (remote, branch and URL id from the status). */
async function pushTo(dir: string, over: Partial<{ remote: string; branch: string; urlId: string }> = {}) {
  const target = data<GitStatus>(await git.status(dir)).push;
  return git.push(dir, { requestId: id(), remote: target?.remote ?? 'origin', branch: target?.branch ?? 'main', urlId: target?.urlId ?? '0'.repeat(16), ...over });
}

const data = <T>(result: { ok: boolean }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return (result as unknown as { data: T }).data;
};

beforeAll(() => {
  lab = realpathSync.native(mkdtempSync(join(tmpdir(), 'mc-git-')));
  const globalConfig = join(lab, 'global.gitconfig');
  writeFileSync(globalConfig, '[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
  env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
  git = new Git({ env });
});

afterAll(() => {
  if (!lab.includes('mc-git-')) throw new Error('unsafe cleanup target');
  rmSync(lab, { recursive: true, force: true });
});

describe('status', () => {
  it('reports branch, clean tree and no upstream', async () => {
    const dir = repo('clean');
    const status = data<GitStatus>(await git.status(dir));
    expect(status).toMatchObject({ branch: 'main', detached: false, initial: false, upstream: null, ahead: 0, behind: 0, files: [], push: null });
    expect(status.head).toMatch(/^[0-9a-f]{7}$/);
  });

  it('parses modified, staged, untracked, deleted, renamed and unicode paths', async () => {
    const dir = repo('mixed');
    write(dir, 'zażółć gęślą.txt', 'x\n');
    write(dir, 'old name.txt', 'some content that stays the same for rename detection\n'.repeat(5));
    write(dir, 'gone.txt', 'bye\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'more files');
    write(dir, 'file.txt', 'changed\n'); // unstaged modification
    sh(dir, 'mv', 'old name.txt', 'new name.txt'); // staged rename
    rmSync(join(dir, 'gone.txt')); // unstaged deletion
    write(dir, 'zażółć gęślą.txt', 'edited\n');
    sh(dir, 'add', 'zażółć gęślą.txt'); // staged unicode modification
    write(dir, 'untracked ✓.txt', 'u\n');
    mkdirSync(join(dir, 'folder'));
    write(join(dir, 'folder'), 'inside.txt', 'i\n');
    const status = data<GitStatus>(await git.status(dir));
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
    expect(byPath['file.txt']).toMatchObject({ x: ' ', y: 'M', staged: false, unstaged: true });
    expect(byPath['new name.txt']).toMatchObject({ x: 'R', origPath: 'old name.txt', staged: true });
    expect(byPath['gone.txt']).toMatchObject({ y: 'D', unstaged: true });
    expect(byPath['zażółć gęślą.txt']).toMatchObject({ x: 'M', staged: true });
    expect(byPath['untracked ✓.txt']).toMatchObject({ untracked: true, x: '?' });
    expect(byPath['folder/']).toMatchObject({ untracked: true });
    expect(Object.keys(byPath).sort()).toEqual(['file.txt', 'folder/', 'gone.txt', 'new name.txt', 'untracked ✓.txt', 'zażółć gęślą.txt']);
  });

  it('flags merge conflicts', async () => {
    const dir = repo('conflict', 1);
    sh(dir, 'checkout', '-q', '-b', 'side');
    write(dir, 'file.txt', 'side\n');
    sh(dir, 'commit', '-qam', 'side change');
    sh(dir, 'checkout', '-q', 'main');
    write(dir, 'file.txt', 'main\n');
    sh(dir, 'commit', '-qam', 'main change');
    expect(() => sh(dir, 'merge', 'side')).toThrow();
    const status = data<GitStatus>(await git.status(dir));
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({ path: 'file.txt', conflict: true });
  });

  it('handles a detached HEAD and a repository without commits', async () => {
    const dir = repo('detached', 2);
    sh(dir, 'checkout', '-q', '--detach', 'HEAD~1');
    const detached = data<GitStatus>(await git.status(dir));
    expect(detached).toMatchObject({ branch: null, detached: true, push: null });
    expect(detached.head).toMatch(/^[0-9a-f]{7}$/);

    const empty = join(lab, 'empty');
    mkdirSync(empty);
    sh(empty, 'init', '-q', '-b', 'main', '.');
    const initial = data<GitStatus>(await git.status(empty));
    expect(initial).toMatchObject({ branch: 'main', initial: true, head: '' });
    const log = data<GitLogPage>(await git.log(empty, { skip: 0, count: 50 }));
    expect(log).toEqual({ commits: [], hasMore: false });
  });

  it('reports ahead and behind of the upstream and the push target', async () => {
    const { clone, other } = remotePair('ab');
    write(other, 'b.txt', 'b\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'from other');
    sh(other, 'push', '-q', 'origin', 'main');
    write(clone, 'c.txt', 'c\n');
    sh(clone, 'add', '.');
    sh(clone, 'commit', '-q', '-m', 'local only');
    sh(clone, 'fetch', '-q');
    const status = data<GitStatus>(await git.status(clone));
    expect(status).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 1, push: { remote: 'origin', branch: 'main', setUpstream: false } });
  });

  it('works from a subfolder and from a non-repository', async () => {
    const dir = repo('sub', 1);
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    const status = data<GitStatus>(await git.status(join(dir, 'a', 'b')));
    expect(samePath(status.root, dir)).toBe(true); // git reports its own spelling of the folder
    const plain = join(lab, 'plain');
    mkdirSync(plain);
    expect(await git.status(plain)).toMatchObject({ ok: false, code: 'not-repo' });
    expect(await git.probe(plain)).toBe('no-repo');
    expect(await git.probe(dir)).toBe('repo');
    expect(await git.probe(join(lab, 'does-not-exist'))).toBe('no-repo');
  });

  it('caps the number of listed changes', async () => {
    const dir = repo('many', 1);
    for (let i = 0; i < 40; i++) write(dir, `f${i}.txt`, 'x');
    const small = new Git({ env });
    const status = data<GitStatus>(await small.status(dir));
    expect(status.files.length).toBe(40);
    const tiny = new Git({ env, maxOutputBytes: 300 });
    const cut = data<GitStatus>(await tiny.status(dir));
    expect(cut.truncated).toBe(true);
    expect(cut.files.length).toBeLessThan(40);
  });
});

describe('history', () => {
  it('pages the log with skip and reports whether there is more', async () => {
    const dir = repo('paging', 7);
    const first = data<GitLogPage>(await git.log(dir, { skip: 0, count: 3 }));
    expect(first.commits.map((c) => c.subject)).toEqual(['commit 7', 'commit 6', 'commit 5']);
    expect(first.hasMore).toBe(true);
    const last = data<GitLogPage>(await git.log(dir, { skip: 6, count: 3 }));
    expect(last.commits.map((c) => c.subject)).toEqual(['commit 1']);
    expect(last.hasMore).toBe(false);
    expect(first.commits[0]).toMatchObject({ author: 'Tester', short: expect.stringMatching(/^[0-9a-f]{7}/) });
    expect(first.commits[0].parents).toEqual([first.commits[1].hash]);
    expect(first.commits[0].refs.some((r) => r.kind === 'branch' && r.name === 'main' && r.current)).toBe(true);
  });

  it('filters by text, author and path, and shows tags', async () => {
    const dir = repo('filters', 3);
    write(dir, 'other.txt', 'o\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '--author', 'Zażółć Gęsia <zg@example.com>', '-m', 'Add [other] file (100%)');
    sh(dir, 'tag', 'v1.0');
    const byText = data<GitLogPage>(await git.log(dir, { skip: 0, count: 50, search: '[other]' }));
    expect(byText.commits.map((c) => c.subject)).toEqual(['Add [other] file (100%)']);
    expect(byText.commits[0].refs.some((r) => r.kind === 'tag' && r.name === 'v1.0')).toBe(true);
    const byCase = data<GitLogPage>(await git.log(dir, { skip: 0, count: 50, search: 'COMMIT 2' }));
    expect(byCase.commits).toHaveLength(1);
    const byAuthor = data<GitLogPage>(await git.log(dir, { skip: 0, count: 50, author: 'zażółć' }));
    expect(byAuthor.commits.map((c) => c.author)).toEqual(['Zażółć Gęsia']);
    const byPath = data<GitLogPage>(await git.log(dir, { skip: 0, count: 50, path: 'other.txt' }));
    expect(byPath.commits).toHaveLength(1);
    // regular expression characters are plain text
    const regex = data<GitLogPage>(await git.log(dir, { skip: 0, count: 50, search: '.*' }));
    expect(regex.commits).toHaveLength(0);
  });

  it('includes other branches with all, and shows commit details with the files of a rename', async () => {
    const dir = repo('details', 1);
    write(dir, 'big.txt', 'content for similarity\n'.repeat(20));
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'add big');
    sh(dir, 'mv', 'big.txt', 'renamed.txt');
    write(dir, 'second.txt', 'a\nb\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'rename and add\n\nBody line one.\nBody line two.');
    const head = (await git.log(dir, { skip: 0, count: 1 }));
    const hash = data<GitLogPage>(head).commits[0].hash;
    const details = data<GitCommitDetails>(await git.show(dir, hash));
    expect(details.message).toBe('rename and add\n\nBody line one.\nBody line two.');
    expect(details.email).toBe('tester@example.com');
    expect(details.files).toEqual([
      { status: 'R', origPath: 'big.txt', path: 'renamed.txt', added: 0, deleted: 0 },
      { status: 'A', path: 'second.txt', added: 2, deleted: 0 },
    ]);
    expect(details.added).toBe(2);
    expect(details.filesTruncated).toBe(false);
    // the root commit has no parent
    const root = data<GitLogPage>(await git.log(dir, { skip: 2, count: 1 })).commits[0];
    const rootDetails = data<GitCommitDetails>(await git.show(dir, root.hash));
    expect(rootDetails.files.map((f) => f.path)).toEqual(['file.txt']);
  });

  it('shows a merge commit against its first parent only', async () => {
    const dir = repo('merge', 1);
    sh(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'feature.txt', 'f\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'feature work');
    sh(dir, 'checkout', '-q', 'main');
    write(dir, 'main.txt', 'm\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'main work');
    sh(dir, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge feature');
    const log = data<GitLogPage>(await git.log(dir, { skip: 0, count: 10 }));
    expect(log.commits[0].parents).toHaveLength(2);
    const details = data<GitCommitDetails>(await git.show(dir, log.commits[0].hash));
    expect(details.files.map((f) => f.path)).toEqual(['feature.txt']);
    const all = data<GitLogPage>(await git.log(dir, { skip: 0, count: 10, all: true }));
    expect(all.commits.length).toBe(log.commits.length);
  });

  it('rejects an unknown commit', async () => {
    const dir = repo('nocommit', 1);
    const result = await git.show(dir, 'deadbeef');
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('diff', () => {
  it('shows working, staged, untracked and commit diffs', async () => {
    const dir = repo('diffs', 2);
    write(dir, 'file.txt', 'line 2\nadded\n');
    const working = data<{ text: string; truncated: boolean }>(await git.diff(dir, { source: 'working', path: 'file.txt' }));
    expect(working.text).toContain('+added');
    expect(working.truncated).toBe(false);
    sh(dir, 'add', 'file.txt');
    const staged = data<{ text: string }>(await git.diff(dir, { source: 'staged', path: 'file.txt' }));
    expect(staged.text).toContain('+added');
    const none = data<{ text: string }>(await git.diff(dir, { source: 'working', path: 'file.txt' }));
    expect(none.text).toBe('');
    write(dir, 'zażółć.txt', 'nowy\r\nplik\r\n');
    const untracked = data<{ text: string }>(await git.diff(dir, { source: 'untracked', path: 'zażółć.txt' }));
    expect(untracked.text).toContain('+nowy');
    const hash = data<GitLogPage>(await git.log(dir, { skip: 0, count: 1 })).commits[0].hash;
    const commit = data<{ text: string }>(await git.diff(dir, { source: 'commit', hash, path: 'file.txt' }));
    expect(commit.text).toContain('-line 1');
    expect(commit.text).toContain('+line 2');
  });

  it('marks binary files and caps huge diffs', async () => {
    const dir = repo('bigdiff', 1);
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
    const bin = data<{ binary: boolean }>(await git.diff(dir, { source: 'untracked', path: 'blob.bin' }));
    expect(bin.binary).toBe(true);
    write(dir, 'huge.txt', 'a long line of text that repeats\n'.repeat(60_000)); // about 2 MB
    const huge = data<{ text: string; truncated: boolean }>(await git.diff(dir, { source: 'untracked', path: 'huge.txt' }));
    expect(huge.truncated).toBe(true);
    expect(huge.text.length).toBeLessThanOrEqual(1024 * 1024);
    expect(huge.text.length).toBeGreaterThan(1000);
  });
});

describe('branches and checkout', () => {
  it('lists local and remote branches and switches only with a clean tree', async () => {
    const { clone, other } = remotePair('br');
    sh(other, 'checkout', '-q', '-b', 'remote-only');
    write(other, 'r.txt', 'r\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'remote branch');
    sh(other, 'push', '-q', 'origin', 'remote-only');
    sh(clone, 'branch', 'local-two');
    sh(clone, 'fetch', '-q');
    const branches = data<Array<{ name: string; remote: boolean; current: boolean }>>(await git.branches(clone));
    expect(branches.map((b) => `${b.remote ? 'r:' : ''}${b.name}${b.current ? '*' : ''}`).sort()).toEqual(['local-two', 'main*', 'r:origin/remote-only']);

    write(clone, 'a.txt', 'dirty\n');
    expect(await git.checkout(clone, { requestId: id(), branch: 'local-two' })).toMatchObject({ ok: false, code: 'dirty' });
    expect(sh(clone, 'branch', '--show-current').trim()).toBe('main');
    sh(clone, 'checkout', '--', 'a.txt');

    expect(await git.checkout(clone, { requestId: id(), branch: 'nope' })).toMatchObject({ ok: false, code: 'invalid' });
    data(await git.checkout(clone, { requestId: id(), branch: 'local-two' }));
    expect(sh(clone, 'branch', '--show-current').trim()).toBe('local-two');
    data(await git.checkout(clone, { requestId: id(), branch: 'origin/remote-only', remote: true }));
    expect(sh(clone, 'branch', '--show-current').trim()).toBe('origin/remote-only'.split('/')[1]);
    expect(sh(clone, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/remote-only');
  });

  it('lets untracked files stay while switching', async () => {
    const dir = repo('untracked-ok', 1);
    sh(dir, 'branch', 'other');
    write(dir, 'new.txt', 'n\n');
    data(await git.checkout(dir, { requestId: id(), branch: 'other' }));
    expect(sh(dir, 'branch', '--show-current').trim()).toBe('other');
  });
});

describe('fetch, pull and push', () => {
  it('fetches and fast-forwards with pull --ff-only', async () => {
    const { clone, other } = remotePair('pull');
    write(other, 'new.txt', 'n\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'upstream change');
    sh(other, 'push', '-q', 'origin', 'main');
    data(await git.fetch(clone, id()));
    expect(data<GitStatus>(await git.status(clone))).toMatchObject({ behind: 1, ahead: 0 });
    const pulled = data<{ message: string }>(await git.pull(clone, id()));
    expect(pulled.message.length).toBeGreaterThan(0);
    expect(data<GitStatus>(await git.status(clone))).toMatchObject({ behind: 0, ahead: 0 });
    expect(sh(clone, 'log', '-1', '--format=%s').trim()).toBe('upstream change');
  });

  it('refuses to pull when the branches diverged and leaves the history alone', async () => {
    const { clone, other } = remotePair('diverged');
    write(other, 'o.txt', 'o\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'theirs');
    sh(other, 'push', '-q', 'origin', 'main');
    write(clone, 'c.txt', 'c\n');
    sh(clone, 'add', '.');
    sh(clone, 'commit', '-q', '-m', 'ours');
    const before = sh(clone, 'rev-parse', 'HEAD').trim();
    const result = await git.pull(clone, id());
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect((result as { error: string }).error).toMatch(/fast-forward|diverg/i);
    expect(sh(clone, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(sh(clone, 'status', '--porcelain').trim()).toBe('');
  });

  it('pushes to the confirmed target only and never forces', async () => {
    const { clone, bare, other } = remotePair('push');
    write(clone, 'p.txt', 'p\n');
    sh(clone, 'add', '.');
    sh(clone, 'commit', '-q', '-m', 'to push');
    const wrong = await pushTo(clone, { branch: 'elsewhere' });
    expect(wrong).toMatchObject({ ok: false, code: 'invalid' });
    expect(sh(bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('first');
    data(await pushTo(clone));
    expect(sh(bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('to push');
    // a rejected (non fast-forward) push stays rejected: no force exists
    write(other, 'x.txt', 'x\n');
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', 'other work');
    const rejected = await pushTo(other);
    expect(rejected).toMatchObject({ ok: false });
    expect(sh(bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('to push');
  });

  it('pushes a branch without upstream with --set-upstream to origin', async () => {
    const { clone, bare } = remotePair('upstream');
    sh(clone, 'checkout', '-q', '-b', 'topic');
    write(clone, 't.txt', 't\n');
    sh(clone, 'add', '.');
    sh(clone, 'commit', '-q', '-m', 'topic work');
    const status = data<GitStatus>(await git.status(clone));
    expect(status.push).toMatchObject({ remote: 'origin', branch: 'topic', setUpstream: true });
    const slashes = (value: string) => value.split(String.fromCharCode(92)).join('/');
    expect(slashes(status.push!.url)).toBe(slashes(join(lab, 'upstream.git')));
    expect(status.push!.urlId).toMatch(/^[0-9a-f]{16}$/);
    data(await pushTo(clone));
    expect(sh(bare, 'log', '-1', '--format=%s', 'topic').trim()).toBe('topic work');
    expect(sh(clone, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/topic');
  });

  it('has no push target without a remote', async () => {
    const dir = repo('noremote', 1);
    expect(data<GitStatus>(await git.status(dir)).push).toBeNull();
    expect(await pushTo(dir)).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('stage, unstage and commit', () => {
  it('stages and unstages chosen paths (spaces, unicode, folders) and commits', async () => {
    const dir = repo('commit', 1);
    write(dir, 'with space.txt', 's\n');
    write(dir, 'zażółć.txt', 'z\n');
    write(dir, '[a].txt', 'm\n');
    write(dir, 'a.txt', 'must stay untracked\n');
    mkdirSync(join(dir, 'fold'));
    write(join(dir, 'fold'), 'in.txt', 'i\n');
    data(await git.stage(dir, { requestId: id(), paths: ['with space.txt', 'zażółć.txt', '[a].txt', 'fold/'] }));
    expect(sh(dir, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort()).toEqual(['[a].txt', 'fold/in.txt', 'with space.txt', 'zażółć.txt']);
    data(await git.unstage(dir, { requestId: id(), paths: ['with space.txt', 'fold/'] }));
    expect(sh(dir, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean).sort()).toEqual(['[a].txt', 'zażółć.txt']);
    const committed = data<{ message: string }>(await git.commit(dir, { requestId: id(), message: 'Dodaj pliki ✓\n\nDrugi akapit z "cudzysłowem" i --option' }));
    expect(committed.message.length).toBeGreaterThan(0);
    expect(sh(dir, 'log', '-1', '--format=%B').trim()).toBe('Dodaj pliki ✓\n\nDrugi akapit z "cudzysłowem" i --option');
    expect(sh(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter(Boolean).sort()).toEqual(['?? a.txt', '?? fold/in.txt', '?? with space.txt']);
  });

  it('stages and unstages everything', async () => {
    const dir = repo('all', 1);
    write(dir, 'a.txt', 'a');
    write(dir, 'file.txt', 'changed');
    data(await git.stage(dir, { requestId: id(), paths: [], all: true }));
    expect(sh(dir, 'diff', '--cached', '--name-only').trim().split('\n').sort()).toEqual(['a.txt', 'file.txt']);
    data(await git.unstage(dir, { requestId: id(), paths: [], all: true }));
    expect(sh(dir, 'diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('unstages in a repository without commits', async () => {
    const dir = join(lab, 'fresh');
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main', '.');
    write(dir, 'a.txt', 'a');
    data(await git.stage(dir, { requestId: id(), paths: ['a.txt'] }));
    data(await git.unstage(dir, { requestId: id(), paths: ['a.txt'] }));
    expect(sh(dir, 'status', '--porcelain').trim()).toBe('?? a.txt');
  });

  it('refuses an empty commit and runs the hooks (they cannot be skipped)', async () => {
    const dir = repo('hooks', 1);
    expect(await git.commit(dir, { requestId: id(), message: 'nothing' })).toMatchObject({ ok: false, code: 'invalid' });
    const hooks = join(dir, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    write(dir, 'x.txt', 'x');
    sh(dir, 'add', '.');
    // a repository with a hook is untrusted until the user says otherwise: nothing runs
    expect(await git.commit(dir, { requestId: id(), message: 'refused' })).toMatchObject({ ok: false, code: 'untrusted' });
    data(await git.grantTrust(dir, id()));
    const blocked = await git.commit(dir, { requestId: id(), message: 'should be blocked' });
    expect(blocked).toMatchObject({ ok: false });
    expect((blocked as { error: string }).error).toContain('hook says no');
    expect(sh(dir, 'log', '--format=%s').trim()).toBe('commit 1');
  });

  it('does not run a request id twice and serializes writers per repository', async () => {
    const dir = repo('replay', 1);
    write(dir, 'r.txt', 'r');
    const rid = id();
    data(await git.stage(dir, { requestId: rid, paths: ['r.txt'] }));
    expect(await git.stage(dir, { requestId: rid, paths: ['r.txt'] })).toMatchObject({ ok: false, code: 'invalid' });
    // A second writer must be refused while the first holds the repository lock. Racing two real calls is timing-dependent (on a
    // slow machine the first can finish before the second checks the lock, and both rightly succeed one after the other), so the
    // lock key the first writer takes is captured and held while the second one runs.
    const busy = (git as unknown as { busy: Set<string> }).busy;
    const first = git.stage(dir, { requestId: id(), paths: ['r.txt'] });
    for (let i = 0; i < 2000 && busy.size === 0; i++) await new Promise((r) => setTimeout(r, 1));
    const [key] = [...busy];
    expect(key).toBeTruthy();
    expect((await first).ok).toBe(true);
    expect(busy.size).toBe(0);
    busy.add(key);
    try {
      expect(await git.stage(dir, { requestId: id(), paths: ['r.txt'] })).toMatchObject({ ok: false, code: 'busy' });
    } finally { busy.delete(key); }
    expect((await git.stage(dir, { requestId: id(), paths: ['r.txt'] })).ok).toBe(true);
  });
});

describe('failures', () => {
  it('reports a missing git with an install hint', async () => {
    const missing = new Git({ bin: 'git-that-does-not-exist-xyz', env });
    const dir = repo('nogit', 1);
    const result = await missing.status(dir);
    expect(result).toMatchObject({ ok: false, code: 'no-git' });
    expect((result as { error: string }).error).toContain('Zainstaluj Git');
    expect(await missing.probe(dir)).toBe('no-git');
  });

  it('stops a slow git at the timeout', async () => {
    const script = join(lab, 'slow-git.js');
    // answers the questions that ask for places (rev-parse, config, worktree) at once and hangs on everything else, like git behind a dead network
    writeFileSync(script, [
      "const a = process.argv; const path = require('path');",
      "if (a.includes('--show-toplevel')) console.log(process.cwd());",
      "else if (a.includes('--absolute-git-dir')) { console.log(path.join(process.cwd(), '.git')); console.log('.git'); }",
      "else if (a.includes('config') || a.includes('worktree') || a.includes('rev-parse')) { /* nothing to say */ }",
      "else setTimeout(() => process.stdout.write('late'), 20000);",
      '',
    ].join('\n'));
    const slow = new Git({ bin: process.execPath, prefixArgs: [script], env, readTimeoutMs: 400 });
    const dir = repo('slow', 1);
    const started = Date.now();
    const result = await slow.status(dir);
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
    const slowNetwork = new Git({ bin: process.execPath, prefixArgs: [script], env, readTimeoutMs: 5000, networkTimeoutMs: 300 });
    expect(await slowNetwork.fetch(dir, id())).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('never prints credentials of a remote URL', async () => {
    const dir = repo('secrets', 1);
    sh(dir, 'remote', 'add', 'origin', 'https://user:s3cr3t-token@127.0.0.1:1/nope.git');
    const result = await git.fetch(dir, id());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('s3cr3t-token');
  });

  it('does not wait for a credential prompt', async () => {
    const dir = repo('prompt', 1);
    // a local server that asks for credentials would hang on a prompt; here the URL is refused at once
    sh(dir, 'remote', 'add', 'origin', 'https://127.0.0.1:1/never.git');
    const started = Date.now();
    expect(await git.fetch(dir, id())).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(15000);
  });
});

describe('worktrees and IPC handling', () => {
  it('lists worktrees and only accepts one git lists', async () => {
    const dir = repo('wt', 1);
    const wt = join(lab, 'wt-wt-linked'); // next to the project as the app makes them: <project>-wt-<name>
    sh(dir, 'worktree', 'add', '-q', '-b', 'mc/linked', wt);
    const elsewhere = join(lab, 'elsewhere-checkout');
    sh(dir, 'worktree', 'add', '-q', '-b', 'mc/elsewhere', elsewhere);
    const list = data<Array<{ path: string; branch: string | null; main: boolean; allowed: boolean }>>(await git.worktrees(dir, dir));
    expect(list).toHaveLength(3);
    expect(list.map((w) => `${w.branch}:${w.allowed}`).sort()).toEqual(['main:true', 'mc/elsewhere:false', 'mc/linked:true']);
    // a worktree outside the project is refused unless a cell of the project uses it
    expect(await git.resolveDir(dir, elsewhere)).toMatchObject({ ok: false, code: 'invalid' });
    expect((await git.resolveDir(dir, elsewhere, [elsewhere])).ok).toBe(true);
    expect(list[0].main).toBe(true);
    const resolved = await git.resolveDir(dir, wt);
    expect(resolved.ok).toBe(true);
    expect(await git.resolveDir(dir, lab)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await git.resolveDir(dir, join(lab, 'wt-wt-linked', '..'))).toMatchObject({ ok: false, code: 'invalid' });
    const status = await handleGit(git, dir, 'status', { worktree: wt }, process.platform === 'win32');
    expect(data<GitStatus>(status).branch).toBe('mc/linked');
  });

  it('validates every request before running anything', async () => {
    const dir = repo('ipc', 2);
    const run = (channel: string, request: unknown, project: string | null = dir) => handleGit(git, project ?? undefined, channel, request, process.platform === 'win32');
    expect(await run('status', {}, null)).toMatchObject({ ok: false, code: 'gone' });
    expect(await run('config', {})).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('status', null)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('show', { hash: '--upload-pack=calc' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('show', { hash: 'HEAD' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('checkout', { requestId: id(), branch: '--orphan' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('checkout', { requestId: id(), branch: 'a b' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('checkout', { branch: 'main' })).toMatchObject({ ok: false, code: 'invalid' }); // no request id
    expect(await run('push', { requestId: id(), remote: '--receive-pack=x', branch: 'main' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('stage', { requestId: id(), paths: ['../outside'] })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('diff', { source: 'working', path: '/etc/passwd' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('log', { skip: -1, count: 10 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('log', { skip: 0, count: 100000 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run('status', { worktree: 'C:\\Windows' })).toMatchObject({ ok: false, code: 'invalid' });
    // a valid log request still works after all of that
    expect(data<GitLogPage>(await run('log', { skip: 0, count: 5 })).commits).toHaveLength(2);
  });

  it('treats search text that looks like an option as text', async () => {
    const dir = repo('inject', 2);
    const outside = join(lab, 'pwned.txt');
    const result = await handleGit(git, dir, 'log', { skip: 0, count: 10, search: `--output=${outside}`, author: '--exec=calc' }, process.platform === 'win32');
    expect(data<GitLogPage>(result).commits).toEqual([]);
    expect(() => renameSync(outside, outside + '.x')).toThrow(); // nothing was written
  });
});
