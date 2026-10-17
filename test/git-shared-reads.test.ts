// Identical git reads that run at the same time share one run; a write in between starts a new one.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Git } from '../src/main/git';

let lab: string;
let log: string;
let wrapper: string;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
/** The git subcommands the wrapper saw (the first argument after the global options). */
const runs = (name: string): number => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line === name).length : 0);

beforeAll(() => {
  lab = mkdtempSync(join(tmpdir(), 'mc-git-shared-'));
  log = join(lab, 'calls.log');
  wrapper = join(lab, 'git-wrapper.cjs');
  // Logs the subcommand, then runs the real git with the same arguments and output.
  writeFileSync(wrapper, `
const { spawnSync } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
let i = 0;
while (i < args.length && (args[i].startsWith('--') || args[i] === '-c')) i += args[i] === '-c' ? 2 : 1;
fs.appendFileSync(${JSON.stringify(log)}, (args[i] || '') + '\\n');
const r = spawnSync('git', args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
});
afterAll(() => { rmSync(lab, { recursive: true, force: true }); });

function repo(name: string): string {
  const dir = join(lab, name);
  mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main', '.');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

describe('shared git reads', () => {
  it('runs one git status for concurrent identical requests and a new one after a write', async () => {
    const dir = repo('status');
    const git = new Git({ bin: process.execPath, prefixArgs: [wrapper], env });
    await git.status(dir); // warm: root, dirs, scan
    rmSync(log, { force: true });
    const [a, b, c] = await Promise.all([git.status(dir), git.status(dir), git.status(dir)]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(a).toEqual(b);
    expect(runs('status')).toBe(1);
    // The push target of the status is remembered: no for-each-ref / remote lookups for the second status.
    expect(runs('for-each-ref')).toBe(0);

    writeFileSync(join(dir, 'b.txt'), 'b\n');
    const staged = await git.stage(dir, { requestId: 'req-stage-1', paths: ['b.txt'] });
    expect(staged.ok).toBe(true);
    const after = await git.status(dir);
    expect(after.ok && after.data.files.some((f) => f.path === 'b.txt')).toBe(true);
  });

  it('shares concurrent trust reads, and a cached read does not scan again within the window', async () => {
    const dir = repo('trust');
    const git = new Git({ bin: process.execPath, prefixArgs: [wrapper], env });
    await git.trustInfo(dir);
    rmSync(log, { force: true });
    const [one, two] = await Promise.all([git.trustInfo(dir), git.trustInfo(dir)]);
    expect(one).toEqual(two);
    expect(runs('config')).toBeGreaterThan(0);
    const fresh = runs('config');
    expect((await git.trustInfo(dir, undefined, true)).ok).toBe(true);
    expect(runs('config')).toBe(fresh); // the scan of a moment ago is reused for display
    expect((await git.trustInfo(dir)).ok).toBe(true);
    expect(runs('config')).toBeGreaterThan(fresh); // the dialog always scans again
  });
});
