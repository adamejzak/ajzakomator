import { describe, expect, it } from 'vitest';
import { backupPathFor, bundlePathFromExecPath, evaluateInstallTarget, probeBundleWrite, type TargetFs } from '../src/main/macUpdate/target';

const EXEC = '/Applications/ajzakomator.app/Contents/MacOS/ajzakomator';

const errno = (code: string) => Object.assign(new Error(code), { code });
/** A file system where everything is fine unless a test says otherwise. */
const fsWith = (over: { denied?: Record<string, string>; owner?: number; uid?: number | undefined } = {}): TargetFs => ({
  accessWritable: async (path) => { if (over.denied?.[path]) throw errno(over.denied[path]); },
  ownerOf: async () => over.owner ?? 501,
  uid: () => ('uid' in over ? over.uid : 501),
});

describe('bundlePathFromExecPath', () => {
  it('derives the .app from the executable inside it', () => {
    expect(bundlePathFromExecPath(EXEC)).toBe('/Applications/ajzakomator.app');
    expect(bundlePathFromExecPath('/Users/me/Apps/My App (1).app/Contents/MacOS/ajzakomator')).toBe('/Users/me/Apps/My App (1).app');
    expect(bundlePathFromExecPath("/Users/o'neil/Applications/ajzakomator.app/Contents/MacOS/ajzakomator")).toBe("/Users/o'neil/Applications/ajzakomator.app");
  });
  it('is undefined outside a bundle', () => {
    expect(bundlePathFromExecPath('/usr/local/bin/node')).toBeUndefined();
    expect(bundlePathFromExecPath('/Applications/ajzakomator.app/Contents/Frameworks/Helper')).toBeUndefined();
    expect(bundlePathFromExecPath('C:\\Program Files\\ajzakomator\\ajzakomator.exe')).toBeUndefined();
    expect(bundlePathFromExecPath('')).toBeUndefined();
  });
  it('names the parked old version next to the app, and not as an .app', () => {
    expect(backupPathFor('/Applications/ajzakomator.app', '0.6.5')).toBe('/Applications/ajzakomator.app.old-0.6.5');
    expect(backupPathFor('/Applications/ajzakomator.app', '0.6.5').endsWith('.app')).toBe(false);
  });
});

describe('evaluateInstallTarget', () => {
  it('accepts a user-owned, writable app in Applications', async () => {
    expect(await evaluateInstallTarget(EXEC, true, fsWith())).toEqual({ ok: true, bundle: '/Applications/ajzakomator.app' });
  });
  it('refuses a build that is not packaged, even inside an .app (the development Electron)', async () => {
    expect(await evaluateInstallTarget('/proj/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', false, fsWith()))
      .toMatchObject({ ok: false, reason: 'not-bundle' });
  });
  it('refuses a process that is not inside an .app', async () => {
    expect(await evaluateInstallTarget('/usr/local/bin/ajzakomator', true, fsWith())).toMatchObject({ ok: false, reason: 'not-bundle' });
  });
  it('refuses translocated (quarantined) launches', async () => {
    const translocated = '/private/var/folders/ab/cd/T/AppTranslocation/1234-ABCD/d/ajzakomator.app/Contents/MacOS/ajzakomator';
    expect(await evaluateInstallTarget(translocated, true, fsWith())).toMatchObject({ ok: false, reason: 'translocated' });
  });
  it('refuses a read-only volume such as the mounted dmg', async () => {
    const exec = '/Volumes/ajzakomator 0.6.5/ajzakomator.app/Contents/MacOS/ajzakomator';
    expect(await evaluateInstallTarget(exec, true, fsWith({ denied: { '/Volumes/ajzakomator 0.6.5': 'EROFS' } })))
      .toMatchObject({ ok: false, reason: 'read-only' });
    expect(await evaluateInstallTarget(exec, true, fsWith({ denied: { '/Volumes/ajzakomator 0.6.5/ajzakomator.app': 'EROFS' } })))
      .toMatchObject({ ok: false, reason: 'read-only' });
  });
  it('refuses a parent folder or bundle the user cannot write', async () => {
    expect(await evaluateInstallTarget(EXEC, true, fsWith({ denied: { '/Applications': 'EACCES' } }))).toMatchObject({ ok: false, reason: 'not-writable' });
    expect(await evaluateInstallTarget(EXEC, true, fsWith({ denied: { '/Applications/ajzakomator.app': 'EPERM' } }))).toMatchObject({ ok: false, reason: 'not-writable' });
  });
  it('refuses a bundle that belongs to another user (administrator install)', async () => {
    expect(await evaluateInstallTarget(EXEC, true, fsWith({ owner: 0 }))).toMatchObject({ ok: false, reason: 'not-owner' });
    // An unreadable owner cannot be shown to be the user either.
    expect(await evaluateInstallTarget(EXEC, true, { ...fsWith(), ownerOf: async () => undefined })).toMatchObject({ ok: false, reason: 'not-owner' });
  });
});

describe('probeBundleWrite', () => {
  it('creates and removes a probe file inside the bundle', async () => {
    const calls: string[] = [];
    expect(await probeBundleWrite('/Applications/ajzakomator.app', async (p) => { calls.push(`write ${p}`); }, async (p) => { calls.push(`rm ${p}`); })).toBe(true);
    expect(calls).toEqual([
      'write /Applications/ajzakomator.app/Contents/.ajzakomator-write-probe',
      'rm /Applications/ajzakomator.app/Contents/.ajzakomator-write-probe',
    ]);
  });
  it('reports a denied write (App Management) and still tries to clean up', async () => {
    let removed = 0;
    expect(await probeBundleWrite('/Applications/ajzakomator.app', async () => { throw errno('EPERM'); }, async () => { removed++; })).toBe(false);
    expect(removed).toBe(1);
  });
});
