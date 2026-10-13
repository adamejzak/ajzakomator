import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, isAbsolute, join, relative } from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createProjectEntry, deleteProjectEntries, renameProjectEntry, transferProjectEntries, type TrashFn } from '../src/main/fileOps';

let fixture: string;
const fixtures: string[] = [];
let root: string;
let trashDir: string;
const trashed: string[] = [];
const trash: TrashFn = async (path) => {
  trashed.push(path);
  await rename(path, join(trashDir, `${trashed.length}-${basename(path)}`));
};
const fs = (path: string) => join(root, path);
const names = async (dir = '') => (await readdir(fs(dir))).sort();

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'mc-fileops-'));
  fixtures.push(fixture);
  root = join(fixture, 'project');
  trashDir = join(fixture, 'trash');
  trashed.length = 0;
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(trashDir);
  await writeFile(join(root, 'a.txt'), 'A');
  await writeFile(join(root, 'src', 'b.txt'), 'B');
  await writeFile(join(root, 'src', 'deep', 'c.txt'), 'C');
  await writeFile(join(root, 'docs', 'a.txt'), 'other A');
  await writeFile(join(fixture, 'outside.txt'), 'outside');
});

afterAll(async () => {
  for (const dir of fixtures) {
    const rel = relative(tmpdir(), dir);
    if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('mc-fileops-')) throw new Error('Unsafe test cleanup target');
    await rm(dir, { recursive: true, force: true });
  }
});

const move = (paths: string[], destination: string, conflict: 'ask' | 'replace' | 'keepBoth' | 'skip' = 'ask') =>
  transferProjectEntries(root, { kind: 'move', paths, destination, conflict }, { trash });
const copy = (paths: string[], destination: string, conflict: 'ask' | 'replace' | 'keepBoth' | 'skip' = 'ask', extra = {}) =>
  transferProjectEntries(root, { kind: 'copy', paths, destination, conflict }, { trash, ...extra });

describe('rename', () => {
  it('renames a file and a folder', async () => {
    expect(await renameProjectEntry(root, 'a.txt', 'z.txt')).toEqual({ ok: true, from: 'a.txt', to: 'z.txt' });
    expect(await renameProjectEntry(root, 'src/deep', 'inner')).toEqual({ ok: true, from: 'src/deep', to: 'src/inner' });
    expect(await readFile(fs('z.txt'), 'utf8')).toBe('A');
    expect(await readFile(fs('src/inner/c.txt'), 'utf8')).toBe('C');
  });

  it('refuses to overwrite and keeps both files', async () => {
    const result = await renameProjectEntry(root, 'a.txt', 'docs');
    expect(result).toMatchObject({ ok: false, error: 'Element o takiej nazwie już istnieje.' });
    expect(await readFile(fs('a.txt'), 'utf8')).toBe('A');
  });

  it('rejects invalid, reserved and path-like names', async () => {
    for (const name of ['', '  ', '.', '..', 'x/y', 'x\0y']) expect(await renameProjectEntry(root, 'a.txt', name), name).toMatchObject({ ok: false });
    for (const name of ['CON', 'nul.txt', 'a.', 'a ', 'a:b', 'a?b', 'COM1']) expect(await renameProjectEntry(root, 'a.txt', name, { platform: 'win32' }), name).toMatchObject({ ok: false });
    expect(await renameProjectEntry(root, 'a.txt', 'CON', { platform: 'linux' })).toMatchObject({ ok: true });
    expect(await names()).toContain('CON');
  });

  it('refuses the project root, traversal and absolute paths', async () => {
    expect(await renameProjectEntry(root, '', 'x')).toMatchObject({ ok: false });
    expect(await renameProjectEntry(root, '../outside.txt', 'x')).toMatchObject({ ok: false });
    expect(await renameProjectEntry(root, join(fixture, 'outside.txt'), 'x')).toMatchObject({ ok: false });
    expect(await renameProjectEntry(root, 'src/../../outside.txt', 'x')).toMatchObject({ ok: false });
    expect(await readFile(join(fixture, 'outside.txt'), 'utf8')).toBe('outside');
  });

  it('refuses entries reached through a junction that leaves the project', async () => {
    await mkdir(join(fixture, 'external'));
    await writeFile(join(fixture, 'external', 'secret.txt'), 'secret');
    await symlink(join(fixture, 'external'), fs('link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await renameProjectEntry(root, 'link/secret.txt', 'x.txt')).toMatchObject({ ok: false });
    expect(await move(['link/secret.txt'], 'docs')).toMatchObject({ ok: false });
    expect(await deleteProjectEntries(root, ['link/secret.txt'], { trash })).toMatchObject({ ok: false });
    expect(await move(['a.txt'], 'link')).toMatchObject({ ok: false });
    expect(await readFile(join(fixture, 'external', 'secret.txt'), 'utf8')).toBe('secret');
    expect(trashed).toEqual([]);
  });

  it('can rename the link itself (the link is inside the project)', async () => {
    await mkdir(join(fixture, 'external'));
    await symlink(join(fixture, 'external'), fs('link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await renameProjectEntry(root, 'link', 'link2')).toMatchObject({ ok: true });
    expect(await names()).toContain('link2');
    expect(await names('..')).toContain('external');
  });

  it('renames case-only, also when the filesystem is case-insensitive', async () => {
    expect(await renameProjectEntry(root, 'a.txt', 'A.txt')).toEqual({ ok: true, from: 'a.txt', to: 'A.txt' });
    expect(await names()).toContain('A.txt');
    expect(await names()).not.toContain('a.txt');
    expect(await readFile(fs('A.txt'), 'utf8')).toBe('A');
    await mkdir(fs('Folder'));
    expect(await renameProjectEntry(root, 'Folder', 'folder')).toMatchObject({ ok: true });
    expect(await names()).toContain('folder');
  });

  it('renaming to the same name is a no-op', async () => {
    expect(await renameProjectEntry(root, 'a.txt', 'a.txt')).toEqual({ ok: true, from: 'a.txt', to: 'a.txt' });
  });
});

describe('create', () => {
  it('creates files and folders without overwriting', async () => {
    expect(await createProjectEntry(root, 'src', 'new.txt', 'file')).toEqual({ ok: true, path: 'src/new.txt' });
    expect(await createProjectEntry(root, '', 'dir', 'directory')).toEqual({ ok: true, path: 'dir' });
    expect(await createProjectEntry(root, 'src', 'b.txt', 'file')).toMatchObject({ ok: false });
    expect(await readFile(fs('src/b.txt'), 'utf8')).toBe('B');
    expect((await stat(fs('dir'))).isDirectory()).toBe(true);
    expect(await createProjectEntry(root, '..', 'x.txt', 'file')).toMatchObject({ ok: false });
    expect(await createProjectEntry(root, 'a.txt', 'x.txt', 'file')).toMatchObject({ ok: false });
  });
});

describe('move', () => {
  it('moves a file and a folder with content into another folder', async () => {
    const result = await move(['a.txt', 'src'], 'docs', 'replace');
    expect(result.ok).toBe(true);
    // a.txt conflicts with docs/a.txt (replaced), src has no conflict
    expect(await names('docs')).toEqual(['a.txt', 'src']);
    expect(await readFile(fs('docs/a.txt'), 'utf8')).toBe('A');
    expect(await readFile(fs('docs/src/deep/c.txt'), 'utf8')).toBe('C');
    expect(await names()).toEqual(['docs']);
  });

  it('moves to the project root', async () => {
    const result = await move(['src/deep'], '');
    expect(result).toMatchObject({ ok: true, done: [{ from: 'src/deep', to: 'deep' }] });
    expect(await readFile(fs('deep/c.txt'), 'utf8')).toBe('C');
  });

  it('reports conflicts first and changes nothing', async () => {
    const result = await move(['a.txt'], 'docs');
    expect(result).toMatchObject({ ok: false, code: 'conflict', conflicts: [{ path: 'docs/a.txt', name: 'a.txt', directory: false }] });
    expect(await readFile(fs('a.txt'), 'utf8')).toBe('A');
    expect(await readFile(fs('docs/a.txt'), 'utf8')).toBe('other A');
  });

  it('replace sends the old item to the trash, never deleting it', async () => {
    await move(['a.txt'], 'docs', 'replace');
    expect(trashed).toEqual([join(await realRoot(), 'docs', 'a.txt')]);
    expect(await names('..')).toContain('trash');
    expect(await readFile(join(trashDir, '1-a.txt'), 'utf8')).toBe('other A');
    expect(await readFile(fs('docs/a.txt'), 'utf8')).toBe('A');
  });

  it('keep both numbers the moved item', async () => {
    await move(['a.txt'], 'docs', 'keepBoth');
    expect(await names('docs')).toEqual(['a copy.txt', 'a.txt']);
    await writeFile(fs('a.txt'), 'A2');
    await move(['a.txt'], 'docs', 'keepBoth');
    expect(await names('docs')).toEqual(['a copy 2.txt', 'a copy.txt', 'a.txt']);
    expect(await readFile(fs('docs/a copy 2.txt'), 'utf8')).toBe('A2');
  });

  it('skip leaves the conflicting item where it was', async () => {
    const result = await move(['a.txt', 'src/b.txt'], 'docs', 'skip');
    expect(result).toMatchObject({ ok: true, skipped: ['a.txt'], done: [{ from: 'src/b.txt', to: 'docs/b.txt' }] });
    expect(await names()).toContain('a.txt');
  });

  it('refuses to move a folder into itself or a descendant', async () => {
    expect(await move(['src'], 'src')).toMatchObject({ ok: false, error: 'Nie można przenieść folderu do niego samego ani do jego podfolderu.' });
    expect(await move(['src'], 'src/deep')).toMatchObject({ ok: false });
    expect(await copy(['src'], 'src/deep')).toMatchObject({ ok: false });
    expect(await names('src')).toEqual(['b.txt', 'deep']);
  });

  it('refuses a replace that would trash the source itself', async () => {
    await mkdir(fs('x/x'), { recursive: true });
    await writeFile(fs('x/x/f.txt'), 'f');
    // moving x/x into x: target x/x is the source's own location -> same place, no-op
    expect(await move(['x/x'], 'x', 'replace')).toMatchObject({ ok: true, done: [], skipped: ['x/x'] });
    // moving x/x/f.txt... into the root where an ancestor named like it lives
    await mkdir(fs('x/y'), { recursive: true });
    await mkdir(fs('x/y/y'), { recursive: true });
    const result = await move(['x/y/y'], 'x', 'replace');
    expect(result).toMatchObject({ ok: true, failed: [{ path: 'x/y/y', error: 'Nie można zastąpić folderu, który zawiera przenoszony element.' }] });
    expect(trashed).toEqual([]);
    expect((await stat(fs('x/y/y'))).isDirectory()).toBe(true);
  });

  it('moving into the folder it is already in is a no-op', async () => {
    expect(await move(['src/b.txt'], 'src')).toMatchObject({ ok: true, done: [], skipped: ['src/b.txt'] });
  });

  it('refuses a destination that is not a folder or does not exist', async () => {
    expect(await move(['a.txt'], 'src/b.txt')).toMatchObject({ ok: false, error: 'Miejsce docelowe nie jest folderem.' });
    expect(await move(['a.txt'], 'nope')).toMatchObject({ ok: false });
  });

  it('drops entries that are inside another selected folder', async () => {
    const result = await move(['src', 'src/deep/c.txt'], 'docs');
    expect(result).toMatchObject({ ok: true, done: [{ from: 'src', to: 'docs/src' }] });
  });

  it('refuses a missing source', async () => {
    expect(await move(['ghost.txt'], 'docs')).toMatchObject({ ok: false });
  });
});

async function realRoot(): Promise<string> {
  const { realpath } = await import('fs/promises');
  return realpath(root);
}

describe('copy', () => {
  it('copies a file and a whole tree and keeps modification times', async () => {
    const when = new Date('2020-01-02T03:04:05Z');
    await utimes(fs('src/b.txt'), when, when);
    const result = await copy(['src'], 'docs');
    expect(result).toMatchObject({ ok: true, done: [{ from: 'src', to: 'docs/src' }] });
    expect(await readFile(fs('docs/src/deep/c.txt'), 'utf8')).toBe('C');
    expect(await readFile(fs('src/deep/c.txt'), 'utf8')).toBe('C');
    expect((await stat(fs('docs/src/b.txt'))).mtime.getTime()).toBe(when.getTime());
  });

  it('pasting into the same folder duplicates as "copy", "copy 2"', async () => {
    expect(await copy(['a.txt'], '')).toMatchObject({ ok: true, done: [{ from: 'a.txt', to: 'a copy.txt' }] });
    expect(await copy(['a.txt'], '')).toMatchObject({ ok: true, done: [{ from: 'a.txt', to: 'a copy 2.txt' }] });
    expect(await copy(['a copy.txt'], '')).toMatchObject({ ok: true, done: [{ to: 'a copy 3.txt' }] });
    expect(await copy(['src'], '')).toMatchObject({ ok: true, done: [{ to: 'src copy' }] });
    expect(await readFile(fs('src copy/deep/c.txt'), 'utf8')).toBe('C');
  });

  it('asks about conflicts, then replaces (old item to the trash) or keeps both', async () => {
    expect(await copy(['a.txt'], 'docs')).toMatchObject({ ok: false, code: 'conflict' });
    await copy(['a.txt'], 'docs', 'keepBoth');
    expect(await names('docs')).toEqual(['a copy.txt', 'a.txt']);
    await copy(['a.txt'], 'docs', 'replace');
    expect(trashed.length).toBe(1);
    expect(await readFile(fs('docs/a.txt'), 'utf8')).toBe('A');
    expect(await readFile(fs('a.txt'), 'utf8')).toBe('A');
  });

  it('does not follow symlinks: they are copied as links or skipped', async () => {
    await mkdir(join(fixture, 'external'));
    await writeFile(join(fixture, 'external', 'secret.txt'), 'secret');
    await mkdir(fs('tree'));
    await writeFile(fs('tree/ok.txt'), 'ok');
    let linked = true;
    try { await symlink(join(fixture, 'external'), fs('tree/link'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
    const result = await copy(['tree'], 'docs');
    expect(result.ok).toBe(true);
    expect(await readFile(fs('docs/tree/ok.txt'), 'utf8')).toBe('ok');
    if (linked) {
      const entries = await names('docs/tree');
      // Either the link was recreated (not its content) or it was skipped with a note.
      if (entries.includes('link')) expect((await (await import('fs/promises')).lstat(fs('docs/tree/link'))).isSymbolicLink()).toBe(true);
      else expect(result.ok && result.notes).toContain('link');
    }
    expect(await readFile(join(fixture, 'external', 'secret.txt'), 'utf8')).toBe('secret');
  });

  it('asks for confirmation above the size/entry limits and goes on once forced', async () => {
    const limits = { bytes: 1000, entries: 3 };
    const warned = await copy(['src'], 'docs', 'ask', { limits });
    expect(warned).toMatchObject({ ok: false, code: 'large' });
    expect(await names('docs')).toEqual(['a.txt']);
    const forced = await transferProjectEntries(root, { kind: 'copy', paths: ['src'], destination: 'docs', conflict: 'ask', force: true }, { trash, limits });
    expect(forced.ok).toBe(true);
    expect(await readFile(fs('docs/src/deep/c.txt'), 'utf8')).toBe('C');
    const bytes = await copy(['a.txt'], 'src', 'ask', { limits: { bytes: 0, entries: 100 } });
    expect(bytes).toMatchObject({ ok: false, code: 'large' });
  });

  it('can be cancelled and leaves no partial copy', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await copy(['src'], 'docs', 'ask', { signal: controller.signal });
    expect(result).toMatchObject({ ok: true, done: [], cancelled: true });
    expect(await names('docs')).toEqual(['a.txt']);
  });

  it('reports progress', async () => {
    const seen: number[] = [];
    await copy(['src'], 'docs', 'ask', { onProgress: (p: { entries: number }) => seen.push(p.entries) });
    expect(seen.at(-1)).toBe(4);
  });
});

describe('delete (to the trash only)', () => {
  it('sends files and folders to the trash and never removes them itself', async () => {
    const result = await deleteProjectEntries(root, ['a.txt', 'src'], { trash });
    expect(result).toEqual({ ok: true, trashed: ['a.txt', 'src'], failed: [] });
    expect(trashed.length).toBe(2);
    expect(await names()).toEqual(['docs']);
    expect(await readFile(join(trashDir, '2-src', 'deep', 'c.txt'), 'utf8')).toBe('C');
  });

  it('collapses nested selections and reports failures per item', async () => {
    const result = await deleteProjectEntries(root, ['src', 'src/b.txt'], { trash });
    expect(result).toMatchObject({ ok: true, trashed: ['src'] });
    expect(trashed.length).toBe(1);
    const failing = await deleteProjectEntries(root, ['a.txt'], { trash: async () => { throw new Error('no bin'); } });
    expect(failing).toMatchObject({ ok: true, trashed: [], failed: [{ path: 'a.txt', error: 'no bin' }] });
    expect(await readFile(fs('a.txt'), 'utf8')).toBe('A');
  });

  it('refuses the project root, outside paths and empty selections', async () => {
    expect(await deleteProjectEntries(root, [''], { trash })).toMatchObject({ ok: false });
    expect(await deleteProjectEntries(root, ['../outside.txt'], { trash })).toMatchObject({ ok: false });
    expect(await deleteProjectEntries(root, [], { trash })).toMatchObject({ ok: false });
    expect(trashed).toEqual([]);
  });
});

describe('one operation never replaces what it just produced', () => {
  it('two sources with the same name: Replace gives the second a free name and trashes nothing', async () => {
    await mkdir(fs('a'));
    await mkdir(fs('b'));
    await mkdir(fs('c'));
    await writeFile(fs('a/x.txt'), 'from a');
    await writeFile(fs('b/x.txt'), 'from b');
    const asked = await move(['a/x.txt', 'b/x.txt'], 'c');
    expect(asked).toMatchObject({ ok: false, code: 'conflict', conflicts: [{ name: 'x.txt', internal: true }] });
    const result = await move(['a/x.txt', 'b/x.txt'], 'c', 'replace');
    expect(result).toMatchObject({ ok: true, replaced: [], done: [{ from: 'a/x.txt', to: 'c/x.txt' }, { from: 'b/x.txt', to: 'c/x copy.txt' }] });
    expect(trashed).toEqual([]);
    expect(await readFile(fs('c/x.txt'), 'utf8')).toBe('from a');
    expect(await readFile(fs('c/x copy.txt'), 'utf8')).toBe('from b');
  });

  it('an existing target is still replaced once (and reported), the duplicate keeps both', async () => {
    await mkdir(fs('a')); await mkdir(fs('b')); await mkdir(fs('c'));
    await writeFile(fs('a/x.txt'), 'from a'); await writeFile(fs('b/x.txt'), 'from b'); await writeFile(fs('c/x.txt'), 'old');
    const result = await move(['a/x.txt', 'b/x.txt'], 'c', 'replace');
    expect(result).toMatchObject({ ok: true, replaced: ['c/x.txt'], done: [{ to: 'c/x.txt' }, { to: 'c/x copy.txt' }] });
    expect(trashed.length).toBe(1);
    expect(await readFile(fs('c/x.txt'), 'utf8')).toBe('from a');
  });

  it('Skip skips the duplicate and copies behave the same', async () => {
    await mkdir(fs('a')); await mkdir(fs('b')); await mkdir(fs('c'));
    await writeFile(fs('a/x.txt'), 'from a'); await writeFile(fs('b/x.txt'), 'from b');
    expect(await copy(['a/x.txt', 'b/x.txt'], 'c', 'skip')).toMatchObject({ ok: true, skipped: ['b/x.txt'], done: [{ to: 'c/x.txt' }] });
    expect(await copy(['a/x.txt', 'b/x.txt'], 'c', 'replace')).toMatchObject({ ok: true, replaced: ['c/x.txt'], done: [{ to: 'c/x.txt' }, { to: 'c/x copy.txt' }] });
  });
});

describe('hostile requests', () => {
  it('rejects unknown conflict policies instead of replacing', async () => {
    for (const conflict of ['bogus', 'REPLACE', '', 1, {}] as unknown[]) {
      const result = await transferProjectEntries(root, { kind: 'move', paths: ['a.txt'], destination: 'docs', conflict: conflict as never }, { trash });
      expect(result, String(conflict)).toMatchObject({ ok: false });
    }
    expect(trashed).toEqual([]);
    expect(await readFile(fs('docs/a.txt'), 'utf8')).toBe('other A');
  });

  it('rejects non-string, oversized and too many paths', async () => {
    const run = (paths: unknown, destination: unknown = 'docs') => transferProjectEntries(root, { kind: 'copy', paths: paths as string[], destination: destination as string, conflict: 'ask' }, { trash });
    expect(await run([{ toString: () => 'a.txt' }])).toMatchObject({ ok: false });
    expect(await run([42])).toMatchObject({ ok: false });
    expect(await run(['a'.repeat(5000)])).toMatchObject({ ok: false });
    expect(await run(Array.from({ length: 5001 }, (_, i) => `f${i}`))).toMatchObject({ ok: false, error: 'Zbyt wiele elementów lub zbyt długa ścieżka.' });
    expect(await run(['a.txt'], 'd'.repeat(5000))).toMatchObject({ ok: false });
    expect(await run(['a.txt'], 5)).toMatchObject({ ok: false });
    expect(await run('a.txt')).toMatchObject({ ok: false });
    expect(await deleteProjectEntries(root, Array.from({ length: 5001 }, (_, i) => `f${i}`), { trash })).toMatchObject({ ok: false });
    expect(await deleteProjectEntries(root, [{ x: 1 } as unknown as string], { trash })).toMatchObject({ ok: false });
    expect(await renameProjectEntry(root, 'a'.repeat(5000), 'x')).toMatchObject({ ok: false });
    expect(await renameProjectEntry(root, 'a.txt', 5 as unknown as string)).toMatchObject({ ok: false });
    expect(trashed).toEqual([]);
  });

  it('handles a large selection quickly (linear de-duplication)', async () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `ghost/${i}`);
    const started = Date.now();
    await transferProjectEntries(root, { kind: 'copy', paths, destination: 'docs', conflict: 'ask' }, { trash });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('cross-device move (EXDEV)', () => {
  const exdev: typeof rename = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };

  it('copies and then removes the source when everything could be copied', async () => {
    const result = await transferProjectEntries(root, { kind: 'move', paths: ['src'], destination: 'docs', conflict: 'ask' }, { trash, hooks: { rename: exdev } });
    expect(result).toMatchObject({ ok: true, done: [{ from: 'src', to: 'docs/src' }] });
    expect(await readFile(fs('docs/src/deep/c.txt'), 'utf8')).toBe('C');
    expect(await names()).not.toContain('src');
  });

  it('keeps the source and leaves no partial copy when a link could not be copied', async () => {
    await mkdir(join(fixture, 'external'));
    try { await symlink(join(fixture, 'external'), fs('src/link'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }
    const failing = (async () => { throw new Error('EPERM'); }) as unknown as typeof symlink;
    const result = await transferProjectEntries(root, { kind: 'move', paths: ['src'], destination: 'docs', conflict: 'ask' }, { trash, hooks: { rename: exdev, symlink: failing } });
    expect(result).toMatchObject({ ok: true, done: [], failed: [{ path: 'src' }], notes: [] });
    expect(await names('src')).toEqual(['b.txt', 'deep', 'link']);
    expect(await readFile(fs('src/deep/c.txt'), 'utf8')).toBe('C');
    expect(await names('docs')).toEqual(['a.txt']);
  });
});
