import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { HookServer } from '../src/main/hooks';
import { createWorktree, isGitRepo, removeWorktree } from '../src/main/worktree';

describe('HookServer', () => {
  it('emits hook events for valid token and rejects others', async () => {
    const s = new HookServer();
    await s.start();
    const got: string[] = [];
    s.on('hook', (cell, ev) => got.push(`${cell}:${ev}`));
    const ok = await fetch(s.url('cell-1', 'stop'), { method: 'POST' });
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe('');
    const bad = await fetch(`http://127.0.0.1:${s.port}/h/wrong/cell-1/stop`, { method: 'POST' });
    expect(bad.status).toBe(403);
    expect(got).toEqual(['cell-1:stop']);
    s.stop();
  });

  it('writes a claude settings file with three hooks', async () => {
    const s = new HookServer();
    await s.start();
    const path = s.writeClaudeSettings(mkdtempSync(join(tmpdir(), 'mc-hooks-')), 'c9');
    const json = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(json.hooks)).toEqual(['UserPromptSubmit', 'Stop', 'Notification']);
    expect(json.hooks.Stop[0].hooks[0].command).toContain(`/h/${s.token}/c9/stop`);
    s.stop();
  });
});

describe('worktree', () => {
  it('creates and removes a worktree on a new branch, suffixing collisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-git-'));
    const repo = join(root, 'proj');
    mkdirSync(repo);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');

    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(root)).toBe(false);
    const wt1 = await createWorktree(repo, 'Cell 3');
    expect(wt1).toEqual({ path: join(root, 'proj-wt-cell-3'), branch: 'mc/cell-3' });
    expect(existsSync(join(wt1.path, 'a.txt'))).toBe(true);
    const wt2 = await createWorktree(repo, 'cell 3');
    expect(wt2.branch).toBe('mc/cell-3-2');
    await removeWorktree(repo, wt1, true);
    expect(existsSync(wt1.path)).toBe(false);
  });
});
