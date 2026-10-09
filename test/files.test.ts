import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join, relative } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listProjectDirectory, PREVIEW_BYTES, readProjectFile } from '../src/main/files';

let fixture: string;
let root: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'mc-files-'));
  root = join(fixture, 'project');
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'nested', 'hello.txt'), 'Cześć, świecie!\n');
  await writeFile(join(root, 'file10.txt'), 'ten');
  await writeFile(join(root, 'file2.txt'), 'two');
  await writeFile(join(fixture, 'outside.txt'), 'outside the project');
});

afterAll(async () => {
  const rel = relative(tmpdir(), fixture);
  if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('mc-files-')) throw new Error('Unsafe test cleanup target');
  await rm(fixture, { recursive: true, force: true });
});

describe('project file browsing', () => {
  it('lists folders first and sorts file names naturally', async () => {
    const listing = await listProjectDirectory(root);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.entries.map((x) => x.name)).toEqual(['nested', 'file2.txt', 'file10.txt']);
    expect((await listProjectDirectory(root, 'nested'))).toMatchObject({ ok: true, entries: [{ path: 'nested/hello.txt', kind: 'file' }] });
  });

  it('reads text without altering the file', async () => {
    expect(await readProjectFile(root, 'nested/hello.txt')).toMatchObject({ kind: 'text', text: 'Cześć, świecie!\n', truncated: false });
  });

  it('blocks traversal and absolute paths', async () => {
    expect(await readProjectFile(root, '../outside.txt')).toMatchObject({ kind: 'error' });
    expect(await readProjectFile(root, join(fixture, 'outside.txt'))).toMatchObject({ kind: 'error' });
    expect(await listProjectDirectory(root, '..')).toMatchObject({ ok: false });
  });

  it('blocks directory junctions leading outside the project', async () => {
    const outside = join(fixture, 'external');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'not in this project');
    await symlink(outside, join(root, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await listProjectDirectory(root, 'external-link')).toMatchObject({ ok: false });
    expect(await readProjectFile(root, 'external-link/secret.txt')).toMatchObject({ kind: 'error' });
  });

  it('limits large previews and handles a UTF-8 character cut at the limit', async () => {
    await writeFile(join(root, 'large.txt'), 'a'.repeat(PREVIEW_BYTES - 1) + 'ą' + 'tail');
    const preview = await readProjectFile(root, 'large.txt');
    expect(preview.kind).toBe('text');
    if (preview.kind !== 'text') return;
    expect(preview.truncated).toBe(true);
    expect(preview.text).toBe('a'.repeat(PREVIEW_BYTES - 1));
  });

  it('supports UTF-16 Windows text files and distinguishes binary content', async () => {
    await writeFile(join(root, 'utf16.txt'), Buffer.from('\ufeffPolskie znaki: ąęć\n', 'utf16le'));
    expect(await readProjectFile(root, 'utf16.txt')).toMatchObject({ kind: 'text', text: 'Polskie znaki: ąęć\n' });
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
    expect(await readProjectFile(root, 'binary.dat')).toMatchObject({ kind: 'binary', size: 4 });
  });

  it('returns useful errors for missing files and prevents previewing directories', async () => {
    expect(await readProjectFile(root, 'missing.txt')).toMatchObject({ kind: 'error', message: expect.stringContaining('nie istnieje') });
    expect(await listProjectDirectory(root, 'missing')).toMatchObject({ ok: false });
    expect(await readProjectFile(root, 'nested')).toMatchObject({ kind: 'error' });
  });
});
