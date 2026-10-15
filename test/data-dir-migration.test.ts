import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATION_MARKER, migrateDataDir, nodeMigrationFs, type MigrationFs, type MigrationOptions } from '../src/main/dataDirMigration';

let appData: string;
let oldDir: string;
let newDir: string;
let logs: string[];
const platform = process.platform;
const NOW = Date.UTC(2026, 9, 15, 12, 30, 0);

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'unimux-migration-'));
  oldDir = join(appData, 'ajzakomator');
  newDir = join(appData, 'unimux');
  logs = [];
});
afterEach(() => rmSync(appData, { recursive: true, force: true }));

const put = (file: string, body = 'x') => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); };
const run = (over: Partial<MigrationOptions> = {}) =>
  migrateDataDir({ appData, platform, env: {}, packaged: true, now: () => NOW, log: (line) => logs.push(line), ...over });
/** Real file operations with selected ones replaced. */
const fsWith = (over: Partial<MigrationFs>): MigrationFs => ({ ...nodeMigrationFs(platform), ...over });
const isLink = (path: string) => lstatSync(path).isSymbolicLink();
const fail = (code: string) => () => { throw Object.assign(new Error(`${code}: operation not permitted`), { code }); };

describe('data directory migration', () => {
  it('uses MC_DATA_DIR as is and touches nothing', () => {
    put(join(oldDir, 'state.json'), 'old');
    expect(run({ env: { MC_DATA_DIR: join(appData, 'custom') } })).toEqual({ dataDir: join(appData, 'custom'), action: 'override' });
    expect(isLink(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(false);
  });

  it('never moves the old directory from a run outside the installed app', () => {
    put(join(oldDir, 'state.json'), 'old');
    expect(run({ packaged: false })).toEqual({ dataDir: oldDir, action: 'not-packaged' });
    expect(isLink(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(false);
  });

  it('moves the old directory and leaves a link to the new one at the old path', () => {
    put(join(oldDir, 'state.json'), 'old');
    put(join(oldDir, 'accounts', 'accounts.json'), '[]');
    expect(run()).toEqual({ dataDir: newDir, action: 'migrated' });
    expect(readFileSync(join(newDir, 'state.json'), 'utf8')).toBe('old');
    expect(readFileSync(join(newDir, 'accounts', 'accounts.json'), 'utf8')).toBe('[]');
    expect(isLink(oldDir)).toBe(true);
    expect(realpathSync(oldDir)).toBe(realpathSync(newDir));
    // Old paths (update windows of 0.8.4, the installer marker) reach the new directory.
    expect(readFileSync(join(oldDir, 'state.json'), 'utf8')).toBe('old');
    writeFileSync(join(oldDir, 'ready'), '0.8.5');
    expect(readFileSync(join(newDir, 'ready'), 'utf8')).toBe('0.8.5');
    expect(JSON.parse(readFileSync(join(newDir, MIGRATION_MARKER), 'utf8'))).toEqual({ from: oldDir, at: NOW });
  });

  it('runs only once: later starts use the new directory through the existing link', () => {
    put(join(oldDir, 'state.json'), 'old');
    run();
    expect(run()).toEqual({ dataDir: newDir, action: 'current' });
    expect(isLink(oldDir)).toBe(true);
    expect(readdirSync(appData).sort()).toEqual(['ajzakomator', 'unimux']);
  });

  it('uses the new directory on a fresh install and creates no link', () => {
    expect(run()).toEqual({ dataDir: newDir, action: 'current' });
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(false);
  });

  it('moves an empty new directory (no state) aside instead of mixing the two', () => {
    put(join(oldDir, 'state.json'), 'old');
    put(join(newDir, 'update', 'installer-done'), '0.8.5');
    expect(run()).toEqual({ dataDir: newDir, action: 'migrated' });
    expect(readFileSync(join(newDir, 'state.json'), 'utf8')).toBe('old');
    const aside = join(appData, 'unimux.pre-migration-2026-10-15T12-30-00-000Z');
    expect(readFileSync(join(aside, 'update', 'installer-done'), 'utf8')).toBe('0.8.5');
    expect(isLink(oldDir)).toBe(true);
  });

  it('leaves both directories alone when the new one already holds a state', () => {
    put(join(oldDir, 'state.json'), 'old');
    put(join(newDir, 'state.json'), 'new');
    expect(run()).toEqual({ dataDir: newDir, action: 'both-exist' });
    expect(isLink(oldDir)).toBe(false);
    expect(readFileSync(join(oldDir, 'state.json'), 'utf8')).toBe('old');
    expect(readFileSync(join(newDir, 'state.json'), 'utf8')).toBe('new');
  });

  it('keeps using the old directory when the rename fails (locked files) and moves it on a later start', () => {
    put(join(oldDir, 'state.json'), 'old');
    expect(run({ fs: fsWith({ rename: fail('EPERM') }) })).toEqual({ dataDir: oldDir, action: 'rename-failed' });
    expect(isLink(oldDir)).toBe(false);
    expect(readFileSync(join(oldDir, 'state.json'), 'utf8')).toBe('old');
    expect(existsSync(newDir)).toBe(false);
    expect(logs.join('\n')).toContain('EPERM');
    expect(run()).toEqual({ dataDir: newDir, action: 'migrated' });
    expect(readFileSync(join(newDir, 'state.json'), 'utf8')).toBe('old');
  });

  it('keeps the old directory when the empty new one cannot be moved aside', () => {
    put(join(oldDir, 'state.json'), 'old');
    mkdirSync(newDir);
    expect(run({ fs: fsWith({ rename: fail('EBUSY') }) })).toEqual({ dataDir: oldDir, action: 'rename-failed' });
    expect(readFileSync(join(oldDir, 'state.json'), 'utf8')).toBe('old');
    expect(existsSync(newDir)).toBe(true);
  });

  it('keeps the old directory when only the second rename fails; the aside copy stays and the next start migrates', () => {
    put(join(oldDir, 'state.json'), 'old');
    mkdirSync(newDir);
    const real = nodeMigrationFs(platform);
    let calls = 0;
    const fs = fsWith({ rename: (from, to) => { calls += 1; if (calls === 2) throw new Error('EPERM'); real.rename(from, to); } });
    expect(run({ fs })).toEqual({ dataDir: oldDir, action: 'rename-failed' });
    expect(readFileSync(join(oldDir, 'state.json'), 'utf8')).toBe('old');
    expect(existsSync(newDir)).toBe(false);
    expect(existsSync(join(appData, 'unimux.pre-migration-2026-10-15T12-30-00-000Z'))).toBe(true);
    expect(run()).toEqual({ dataDir: newDir, action: 'migrated' });
  });

  it('uses the new directory when the link cannot be created and creates it on the next start', () => {
    put(join(oldDir, 'state.json'), 'old');
    expect(run({ fs: fsWith({ symlink: fail('EPERM') }) })).toEqual({ dataDir: newDir, action: 'migrated-without-link' });
    expect(existsSync(oldDir)).toBe(false);
    expect(readFileSync(join(newDir, 'state.json'), 'utf8')).toBe('old');
    expect(logs.join('\n')).toContain('could not be created');
    expect(run()).toEqual({ dataDir: newDir, action: 'current' });
    expect(isLink(oldDir)).toBe(true);
    expect(readFileSync(join(oldDir, 'state.json'), 'utf8')).toBe('old');
  });

  it('keeps a link the user made to another place as the data directory', () => {
    const elsewhere = join(appData, 'elsewhere');
    put(join(elsewhere, 'state.json'), 'mine');
    nodeMigrationFs(platform).symlink(elsewhere, oldDir);
    expect(run()).toEqual({ dataDir: oldDir, action: 'user-link' });
    expect(existsSync(newDir)).toBe(false);
    expect(readFileSync(join(oldDir, 'state.json'), 'utf8')).toBe('mine');
  });

  it('follows another instance that moved the directory first instead of recreating the old one', () => {
    put(join(oldDir, 'state.json'), 'old');
    const real = nodeMigrationFs(platform);
    const fs = fsWith({ rename: (from, to) => { real.rename(from, to); throw new Error('ENOENT: already moved'); } });
    expect(run({ fs })).toEqual({ dataDir: newDir, action: 'current' });
    expect(existsSync(oldDir)).toBe(false);
    expect(readFileSync(join(newDir, 'state.json'), 'utf8')).toBe('old');
  });

  it('still migrates when the marker cannot be written', () => {
    put(join(oldDir, 'state.json'), 'old');
    expect(run({ fs: fsWith({ writeFile: fail('EACCES') }) })).toEqual({ dataDir: newDir, action: 'migrated' });
    expect(isLink(oldDir)).toBe(true);
  });

  it('waits while the update window of the previous version still works in the old directory', () => {
    put(join(oldDir, 'state.json'), 'old');
    const seen: string[] = [];
    expect(run({ busy: (dir) => { seen.push(dir); return true; } })).toEqual({ dataDir: oldDir, action: 'deferred' });
    expect(seen).toEqual([oldDir]);
    expect(isLink(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(false);
    expect(run({ busy: () => false })).toEqual({ dataDir: newDir, action: 'migrated' });
  });

  it('never moves anything when the old path is a link or a file', () => {
    mkdirSync(join(appData, 'elsewhere'));
    nodeMigrationFs(platform).symlink(join(appData, 'elsewhere'), oldDir);
    expect(run()).toEqual({ dataDir: oldDir, action: 'user-link' });
    expect(isLink(oldDir)).toBe(true);
    (platform === 'win32' ? rmdirSync : unlinkSync)(oldDir);
    writeFileSync(oldDir, 'not a directory');
    expect(run()).toEqual({ dataDir: newDir, action: 'current' });
    expect(readFileSync(oldDir, 'utf8')).toBe('not a directory');
    expect(existsSync(newDir)).toBe(false);
  });

  it('never deletes: a failed run leaves every file where it was', () => {
    put(join(oldDir, 'state.json'), 'old');
    put(join(oldDir, 'sessions', 'a.json'), 'a');
    const fs = fsWith({ rename: fail('EPERM'), symlink: fail('EPERM'), writeFile: fail('EPERM') });
    run({ fs });
    expect(readdirSync(oldDir).sort()).toEqual(['sessions', 'state.json']);
    expect(readFileSync(join(oldDir, 'sessions', 'a.json'), 'utf8')).toBe('a');
  });
});
