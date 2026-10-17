import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjectDirectories } from '../src/main/files';
import { replaceInProject, searchProject } from '../src/main/search';
import { buildPattern, compileGlobs, expandReplacement, MAX_LINE_LENGTH, replaceInText, searchText } from '../src/shared/search';

const regexOf = (options: Parameters<typeof buildPattern>[0]) => {
  const built = buildPattern(options);
  if ('error' in built) throw new Error(built.error);
  return built.regex;
};

describe('search text engine', () => {
  it('escapes literal queries and ignores case unless asked', () => {
    expect(searchText('a.b A.B axb', regexOf({ query: 'a.b' })).matches.map((m) => m.text)).toEqual(['a.b', 'A.B']);
    expect(searchText('a.b A.B', regexOf({ query: 'a.b', caseSensitive: true })).matches.map((m) => m.text)).toEqual(['a.b']);
  });

  it('matches whole words, including letters outside ASCII', () => {
    const word = regexOf({ query: 'żółw', wholeWord: true });
    expect(searchText('żółw żółwik mały-żółw', word).matches.map((m) => m.column)).toEqual([0, 17]);
    expect(searchText('cat concat cat_ cat', regexOf({ query: 'cat', wholeWord: true })).matches.map((m) => m.column)).toEqual([0, 16]);
  });

  it('supports regular expressions and reports invalid ones', () => {
    expect(searchText('id=12 id=7', regexOf({ query: 'id=(\\d+)', regex: true })).matches.map((m) => m.text)).toEqual(['id=12', 'id=7']);
    const bad = buildPattern({ query: '(', regex: true });
    expect('error' in bad && bad.error.length > 0).toBe(true);
    expect(buildPattern({ query: '' })).toEqual({ error: '' });
  });

  it('reports line and column of every match and a shortened preview', () => {
    const long = `${'x'.repeat(200)}needle${'y'.repeat(400)}`;
    const { matches } = searchText(`first\r\nsecond needle\nthird\r${long}`, regexOf({ query: 'needle' }));
    expect(matches.map((m) => [m.line, m.column])).toEqual([[2, 7], [4, 200]]);
    expect(matches[0]).toMatchObject({ preview: 'second needle', matchStart: 7, matchLength: 6 });
    const shortened = matches[1];
    expect(shortened.preview.startsWith('…')).toBe(true);
    expect(shortened.preview.slice(shortened.matchStart, shortened.matchStart + shortened.matchLength)).toBe('needle');
    expect(shortened.preview.length).toBeLessThan(260);
  });

  it('skips empty matches and giant lines, and stops at the limit', () => {
    expect(searchText('abc', regexOf({ query: 'x*', regex: true })).matches).toEqual([]);
    expect(searchText('a'.repeat(MAX_LINE_LENGTH + 1), regexOf({ query: 'a' })).matches).toEqual([]);
    const limited = searchText('a a a a a', regexOf({ query: 'a' }), 3);
    expect(limited.matches).toHaveLength(3);
    expect(limited.truncated).toBe(true);
  });

  it('replaces literally unless the search is a regular expression', () => {
    expect(replaceInText('cost $5, cost $6', { regex: regexOf({ query: 'cost' }), replacement: '$&!', expand: false })).toEqual({ text: '$&! $5, $&! $6', count: 2 });
    const regex = regexOf({ query: '(\\w+)@(?<host>\\w+)', regex: true });
    expect(replaceInText('ann@home bob@work', { regex, replacement: '$2:$1 [$<host>] $$ $&', expand: true }))
      .toEqual({ text: 'home:ann [home] $ ann@home work:bob [work] $ bob@work', count: 2 });
  });

  it('replaces one occurrence and keeps every kind of line ending', () => {
    const text = 'one\r\ntwo two\ntwo\rend';
    const regex = regexOf({ query: 'two' });
    expect(replaceInText(text, { regex, replacement: '2', expand: false })).toEqual({ text: 'one\r\n2 2\n2\rend', count: 3 });
    expect(replaceInText(text, { regex, replacement: '2', expand: false, only: { line: 2, column: 4, text: 'two' } })).toEqual({ text: 'one\r\ntwo 2\ntwo\rend', count: 1 });
    expect(replaceInText(text, { regex, replacement: '2', expand: false, only: { line: 2, column: 5, text: 'two' } }).count).toBe(0);
  });

  it('expands replacement tokens like String.replace', () => {
    const match = /(a)(b)?/.exec('a') as RegExpExecArray;
    expect(expandReplacement('[$1|$2|$3|$$|$&]', match)).toBe('[a||$3|$|a]');
  });

  it('compiles file globs', () => {
    const ts = compileGlobs('*.ts, src/**');
    expect(ts?.('a/b/c.ts')).toBe(true);
    expect(ts?.('src/deep/readme.md')).toBe(true);
    expect(ts?.('docs/readme.md')).toBe(false);
    expect(compileGlobs('docs/')?.('docs/a/b.md')).toBe(true);
    expect(compileGlobs('src/*.js')?.('src/sub/x.js')).toBe(false);
    expect(compileGlobs('  ')).toBeNull();
  });
});

describe('project search and replace', () => {
  let root: string;
  const put = (path: string, body: string | Buffer) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); };
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ajza-search-'));
    put('src/a.ts', 'const TOKEN = 1;\nconsole.log(TOKEN);\n');
    put('src/deep/b.ts', 'token here\r\nand token there\r\n');
    put('notes.md', 'Token in notes');
    put('node_modules/pkg/index.js', 'token inside dependencies');
    put('.git/config', 'token in git');
    put('image.bin', Buffer.from([0x74, 0x6f, 0x6b, 0x65, 0x6e, 0x00, 0x01]));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('finds matches across the project and skips dependencies, git data and binary files', async () => {
    const result = await searchProject(root, { query: 'token' });
    expect(result.ok && result.files.map((f) => [f.path, f.matches.length])).toEqual([['notes.md', 1], ['src/a.ts', 3 - 1], ['src/deep/b.ts', 2]]);
    expect(result.ok && result.matches).toBe(5);
    expect(result.ok && result.skipped).toBe(1);
    const all = await searchProject(root, { query: 'token', includeIgnored: true });
    expect(all.ok && all.files.map((f) => f.path)).toEqual(expect.arrayContaining(['node_modules/pkg/index.js', '.git/config']));
  });

  it('honours case, whole word, include and exclude filters', async () => {
    expect((await searchProject(root, { query: 'Token', caseSensitive: true }) as { files: unknown[] }).files).toHaveLength(1);
    expect((await searchProject(root, { query: 'tok', wholeWord: true }) as { files: unknown[] }).files).toHaveLength(0);
    const ts = await searchProject(root, { query: 'token', include: '*.ts' });
    expect(ts.ok && ts.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/deep/b.ts']);
    const without = await searchProject(root, { query: 'token', include: '*.ts', exclude: 'src/deep/' });
    expect(without.ok && without.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('reports a bad regular expression, accepts an empty query and skips large files', async () => {
    expect(await searchProject(root, { query: '(', regex: true })).toMatchObject({ ok: false });
    expect(await searchProject(root, { query: '' })).toMatchObject({ ok: true, files: [] });
    put('big.txt', `token${'x'.repeat(300 * 1024)}`);
    const result = await searchProject(root, { query: 'token' });
    expect(result.ok && result.files.some((f) => f.path === 'big.txt')).toBe(false);
    expect(result.ok && result.skipped).toBe(2);
  });

  it('stops when the match limit or the time budget is reached', async () => {
    put('many.txt', 'x\n'.repeat(6000));
    const limited = await searchProject(root, { query: 'x' });
    expect(limited.ok && limited.truncated).toBe(true);
    expect(limited.ok && limited.matches).toBe(5000);
    let tick = 0;
    const slow = await searchProject(root, { query: 'token' }, () => (tick += 6000));
    expect(slow.ok && slow.truncated).toBe(true);
  });

  it('stops a search that a newer one replaced and still finds everything when reading files in parallel', async () => {
    for (let i = 0; i < 40; i++) put(`bulk/f${i}.txt`, i % 3 ? 'nothing\n' : `token ${i}\n`);
    const full = await searchProject(root, { query: 'token' });
    expect(full.ok && full.files.filter((f) => f.path.startsWith('bulk/')).map((f) => f.path))
      .toEqual(Array.from({ length: 40 }, (_, i) => i).filter((i) => i % 3 === 0).map((i) => `bulk/f${i}.txt`).sort((a, b) => a.localeCompare(b, 'pl', { numeric: true })));
    expect(full.ok && full.scanned).toBeGreaterThanOrEqual(40);

    const before = new AbortController();
    before.abort();
    expect(await searchProject(root, { query: 'token' }, Date.now, before.signal)).toEqual({ ok: true, files: [], matches: 0, scanned: 0, skipped: 0, truncated: true });

    // Aborted while running (the clock is read once per started file): the rest of the project is not read.
    const during = new AbortController();
    let calls = 0;
    const stopped = await searchProject(root, { query: 'token' }, () => { if (++calls === 3) during.abort(); return 0; }, during.signal);
    expect(stopped).toMatchObject({ ok: true, files: [], truncated: true });
  });

  it('replaces in every matching file and keeps line endings', async () => {
    const result = await replaceInProject(root, { options: { query: 'token' }, replacement: 'key', scope: { kind: 'all' } });
    expect(result).toMatchObject({ ok: true, replaced: 5 });
    expect(read('src/a.ts')).toBe('const key = 1;\nconsole.log(key);\n');
    expect(read('src/deep/b.ts')).toBe('key here\r\nand key there\r\n');
    expect(read('node_modules/pkg/index.js')).toBe('token inside dependencies');
    expect(read('image.bin').includes('\u0000')).toBe(true);
  });

  it('replaces only one file or one occurrence when asked', async () => {
    const file = await replaceInProject(root, { options: { query: 'token' }, replacement: 'key', scope: { kind: 'file', path: 'src/deep/b.ts' } });
    expect(file).toMatchObject({ ok: true, replaced: 2 });
    expect(read('notes.md')).toBe('Token in notes');
    const one = await replaceInProject(root, { options: { query: 'token' }, replacement: 'key', scope: { kind: 'match', path: 'src/a.ts', line: 2, column: 12, text: 'TOKEN' } });
    expect(one).toMatchObject({ ok: true, replaced: 1 });
    expect(read('src/a.ts')).toBe('const TOKEN = 1;\nconsole.log(key);\n');
  });

  it('refuses a single replacement when the file changed since the search', async () => {
    const stale = await replaceInProject(root, { options: { query: 'token' }, replacement: 'key', scope: { kind: 'match', path: 'src/a.ts', line: 1, column: 99, text: 'TOKEN' } });
    expect(stale).toMatchObject({ ok: true, replaced: 0 });
    expect(stale.ok && stale.files[0].error).toMatch(/zmienił się/);
    expect(read('src/a.ts')).toBe('const TOKEN = 1;\nconsole.log(TOKEN);\n');
  });

  it('keeps a byte order mark and expands regular-expression groups', async () => {
    put('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name: ann\n')]));
    const result = await replaceInProject(root, { options: { query: 'name: (\\w+)', regex: true }, replacement: 'user=$1', scope: { kind: 'file', path: 'bom.txt' } });
    expect(result).toMatchObject({ ok: true, replaced: 1 });
    expect([...readFileSync(join(root, 'bom.txt')).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(readFileSync(join(root, 'bom.txt'), 'utf8')).toBe('﻿user=ann\n');
  });

  it('reports files that cannot be replaced and rejects invalid requests', async () => {
    const binary = await replaceInProject(root, { options: { query: 'token' }, replacement: 'k', scope: { kind: 'file', path: 'image.bin' } });
    expect(binary.ok && binary.files[0]).toMatchObject({ path: 'image.bin', replaced: 0 });
    expect(binary.ok && binary.files[0].error).toBeTruthy();
    expect(await replaceInProject(root, { options: { query: '' }, replacement: 'k', scope: { kind: 'all' } })).toMatchObject({ ok: false });
    expect(await replaceInProject(root, { options: { query: '(', regex: true }, replacement: 'k', scope: { kind: 'all' } })).toMatchObject({ ok: false });
    const outside = await replaceInProject(root, { options: { query: 'a' }, replacement: 'k', scope: { kind: 'file', path: '../outside.txt' } });
    expect(outside.ok && outside.files[0].error).toBeTruthy();
  });

  it('lists folders breadth first without dependency folders and honours the limit', async () => {
    mkdirSync(join(root, 'src', 'deep', 'deeper'), { recursive: true });
    const all = await listProjectDirectories(root);
    expect(all).toEqual({ ok: true, paths: ['src', 'src/deep', 'src/deep/deeper'], truncated: false });
    expect(await listProjectDirectories(root, 2)).toEqual({ ok: true, paths: ['src', 'src/deep'], truncated: true });
  });
});
