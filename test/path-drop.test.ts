import { describe, expect, it } from 'vitest';
import {
  buildPathPayload, buildPathText, dropBlock, hasControlChars, MAX_DROP_ITEMS, MAX_DROP_TEXT, parsePathPayload, psLiteral, quoteForShell,
  relativeInside, validRelPath,
} from '../src/shared/pathDrop';

const winOpts = { cwd: 'D:\\Projekty\\app', platform: 'win32' as const, shell: 'pwsh' as const };
const posixOpts = { cwd: '/home/u/app', platform: 'linux' as const, shell: 'bash' as const };
const item = (abs: string, kind: 'file' | 'dir' = 'file') => ({ kind, abs });
const ch = (code: number) => String.fromCharCode(code);

describe('relative paths', () => {
  it('relates a path to the cell folder with forward slashes, ignoring drive letter case on Windows', () => {
    expect(relativeInside('D:\\Projekty\\app', 'D:\\Projekty\\app\\src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(relativeInside('d:\\projekty\\app\\', 'D:\\Projekty\\App\\src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(relativeInside('D:\\Projekty\\app', 'D:\\Projekty\\app', 'win32')).toBe('.');
    expect(relativeInside('D:\\Projekty\\app', 'D:\\Projekty\\app2\\a.ts', 'win32')).toBeNull();
    expect(relativeInside('D:\\Projekty\\app', 'E:\\Projekty\\app\\a.ts', 'win32')).toBeNull();
    expect(relativeInside('/home/u/app', '/home/u/app/src/a.ts', 'linux')).toBe('src/a.ts');
    expect(relativeInside('/home/u/app', '/home/u/App/src/a.ts', 'linux')).toBeNull();
    expect(relativeInside('/', '/etc/hosts', 'linux')).toBe('etc/hosts');
    expect(relativeInside('/home/u/app', '/home/u/app/a\\b.txt', 'linux')).toBe('a\\b.txt');
  });
});

describe('text inserted into a Claude cell', () => {
  it('uses @ mentions relative to the cell folder, absolute outside it, folders with a trailing slash', () => {
    expect(buildPathText('claude', [item('D:\\Projekty\\app\\src\\a.ts')], winOpts)).toEqual({ text: '@src/a.ts ', skipped: 0 });
    expect(buildPathText('claude', [item('D:\\Projekty\\app\\src', 'dir')], winOpts).text).toBe('@src/ ');
    expect(buildPathText('claude', [item('D:\\Other\\x.txt')], winOpts).text).toBe('@D:\\Other\\x.txt ');
    expect(buildPathText('claude', [item('D:\\Other\\dir', 'dir')], winOpts).text).toBe('@D:\\Other\\dir\\ ');
    expect(buildPathText('claude', [item('/home/u/app/a.ts'), item('/home/u/app/docs', 'dir'), item('/tmp/z')], posixOpts).text).toBe('@a.ts @docs/ @/tmp/z ');
  });

  it('quotes paths with whitespace the way @ mentions expect', () => {
    expect(buildPathText('claude', [item('D:\\Projekty\\app\\my dir\\a b.ts')], winOpts).text).toBe('@"my dir/a b.ts" ');
    expect(buildPathText('claude', [item('/home/u/app/tab\there.txt')], posixOpts).text).toBe('');
    const nbsp = `nb${ch(0xa0)}sp.txt`;
    expect(buildPathText('claude', [item(`/home/u/app/${nbsp}`)], posixOpts).text).toBe(`@"${nbsp}" `);
  });

  it('keeps characters that matter to shells as they are (an @ mention is not a shell command)', () => {
    expect(buildPathText('claude', [item('/home/u/app/$HOME & (x) `y` ;z.txt')], posixOpts).text).toBe('@"$HOME & (x) `y` ;z.txt" ');
    expect(buildPathText('claude', [item('/home/u/app/zażółć gęślą.txt')], posixOpts).text).toBe('@"zażółć gęślą.txt" ');
    expect(buildPathText('claude', [item('/home/u/app/a&b$c.txt')], posixOpts).text).toBe('@a&b$c.txt ');
  });

  it('falls back to the plain path when the name has both whitespace and a double quote', () => {
    expect(buildPathText('claude', [item('/home/u/app/say "hi" now.txt')], posixOpts).text).toBe('say "hi" now.txt ');
  });

  it('inserts several items separated by a space and a trailing space', () => {
    expect(buildPathText('claude', [item('/home/u/app/a'), item('/home/u/app/b', 'dir')], posixOpts)).toEqual({ text: '@a @b/ ', skipped: 0 });
  });
});

describe('text inserted into a Codex cell', () => {
  it('uses the plain relative path (a literal @ attaches nothing in Codex), quoted when it has whitespace', () => {
    expect(buildPathText('codex', [item('/home/u/app/src/a.ts'), item('/home/u/app/docs', 'dir')], posixOpts).text).toBe('src/a.ts docs/ ');
    expect(buildPathText('codex', [item('/home/u/app/a b.ts')], posixOpts).text).toBe('"a b.ts" ');
    expect(buildPathText('codex', [item('D:\\Elsewhere\\f.txt')], winOpts).text).toBe('D:\\Elsewhere\\f.txt ');
  });
});

describe('text inserted into a shell cell', () => {
  it('quotes the absolute path for PowerShell, doubling every kind of single quote', () => {
    expect(buildPathText('shell', [item("D:\\Projekty\\app\\it's.txt")], winOpts).text).toBe("'D:\\Projekty\\app\\it''s.txt' ");
    const [a, b, c, d] = [ch(0x2019), ch(0x2018), ch(0x201a), ch(0x201b)];
    expect(psLiteral(`x${a}y${b}z${c}w${d}v`)).toBe(`'x${a}${a}y${b}${b}z${c}${c}w${d}${d}v'`);
    expect(buildPathText('shell', [item('D:\\Projekty\\app\\$env:X & (a) `b`.txt')], winOpts).text).toBe("'D:\\Projekty\\app\\$env:X & (a) `b`.txt' ");
    expect(buildPathText('shell', [item('D:\\Projekty\\app\\src', 'dir')], { ...winOpts, shell: 'powershell' }).text).toBe("'D:\\Projekty\\app\\src' ");
  });

  it('quotes for cmd with double quotes and refuses a name with a double quote', () => {
    const cmd = { ...winOpts, shell: 'cmd' as const };
    expect(buildPathText('shell', [item('D:\\Projekty\\app\\a & b ^ c.txt')], cmd).text).toBe('"D:\\Projekty\\app\\a & b ^ c.txt" ');
    expect(quoteForShell('a"b', 'cmd')).toBeNull();
    expect(buildPathText('shell', [item('D:\\x\\a"b')], cmd)).toEqual({ text: '', skipped: 1 });
  });

  it('quotes for POSIX shells so that nothing expands', () => {
    expect(buildPathText('shell', [item("/home/u/app/it's $HOME `x` $(y) & ;.txt")], posixOpts).text).toBe(`'/home/u/app/it'"'"'s $HOME \`x\` $(y) & ;.txt' `);
    expect(buildPathText('shell', [item('/home/u/app/zażółć')], { ...posixOpts, shell: 'zsh' }).text).toBe("'/home/u/app/zażółć' ");
  });

  it('keeps a drive root intact', () => {
    expect(buildPathText('shell', [item('C:\\', 'dir')], winOpts).text).toBe("'C:\\' ");
  });
});

describe('unsafe names', () => {
  const hostile = ['a\nb', 'a\rb', 'a\u001b[201~b', 'a\u0000b', `a${ch(0x2028)}b`, `a${ch(0x2029)}b`, 'a\u0085b', 'a\u007fb'];
  it('never lets control characters or newlines into the inserted text', () => {
    for (const name of hostile) {
      for (const target of ['claude', 'codex', 'shell'] as const) {
        const result = buildPathText(target, [item(`/home/u/app/${name}`), item('/home/u/app/ok.txt')], posixOpts);
        expect(hasControlChars(result.text), `${target} ${JSON.stringify(name)}`).toBe(false);
        expect(result.skipped).toBe(1);
        expect(result.text).toContain('ok.txt');
      }
    }
  });

  it('limits one token and the whole text', () => {
    const long = `/home/u/app/${'x'.repeat(5000)}`;
    expect(buildPathText('claude', [item(long)], posixOpts)).toEqual({ text: '', skipped: 1 });
    const many = Array.from({ length: 90 }, (_, i) => item(`/home/u/app/${'n'.repeat(1000)}${i}`));
    const result = buildPathText('claude', many, posixOpts);
    expect(result.text.length).toBeLessThanOrEqual(MAX_DROP_TEXT);
    expect(result.skipped).toBeGreaterThan(0);
    expect(buildPathText('claude', [item(`/home/u/app/${'y'.repeat(300)}.txt`)], posixOpts).skipped).toBe(0);
  });
});

describe('relative path validation', () => {
  it('accepts project-relative forward-slash paths only', () => {
    for (const ok of ['a', 'src/a.ts', 'dir with space/x y', 'zażółć/ü', '.hidden/.env', 'a..b/c']) expect(validRelPath(ok, 'linux'), ok).toBe(true);
    for (const bad of ['', '/', '/etc/passwd', 'a/', '../x', 'a/../x', 'a/./b', './a', 'a//b', 'a\nb', 'a\u001bb', 5, null, undefined, {}]) expect(validRelPath(bad, 'linux'), String(bad)).toBe(false);
    expect(validRelPath('x'.repeat(5000), 'linux')).toBe(false);
  });

  it('refuses drive letters and backslashes on Windows, where they would escape the project', () => {
    for (const bad of ['C:/x', 'C:x', 'a\\b', '..\\x', '\\\\server\\share']) expect(validRelPath(bad, 'win32'), bad).toBe(false);
    expect(validRelPath('a\\b', 'linux')).toBe(true);
  });
});

describe('drag payload', () => {
  it('round-trips what the tree builds and drops the carried absolute path', () => {
    const raw = buildPathPayload('p1', 'D:\\Projekty\\app', [{ relPath: 'src/a.ts', kind: 'file' }, { relPath: 'src', kind: 'directory' }, { relPath: 'l', kind: 'symlink' }, { relPath: 'u', kind: undefined }], 'win32');
    const parsed = parsePathPayload(raw, 'win32')!;
    expect(parsed.rejected).toBe(0);
    expect(parsed.items).toEqual([
      { kind: 'file', projectId: 'p1', relPath: 'src/a.ts', absPath: undefined },
      { kind: 'dir', projectId: 'p1', relPath: 'src', absPath: undefined },
      { kind: 'file', projectId: 'p1', relPath: 'l', absPath: undefined },
      { kind: 'file', projectId: 'p1', relPath: 'u', absPath: undefined },
    ]);
    expect(JSON.parse(raw).items[0].absPath).toBe('D:\\Projekty\\app\\src\\a.ts');
  });

  it('accepts a single bare item as well', () => {
    expect(parsePathPayload(JSON.stringify({ kind: 'dir', projectId: 'p', relPath: 'x', absPath: '/r/x' }))!.items).toHaveLength(1);
  });

  it('returns null for data that is not ours', () => {
    for (const raw of [undefined, null, 5, '', 'nope', '[]', '"x"', 'null', '{"items":[]}', 'x'.repeat(2_000_000)]) expect(parsePathPayload(raw), String(raw).slice(0, 12)).toBeNull();
  });

  it('treats an object without a usable item list as one refused item', () => {
    expect(parsePathPayload('{"items":5}')).toEqual({ items: [], rejected: 1 });
  });

  it('refuses malformed, escaping and unsafe items and counts them', () => {
    const items = [
      { kind: 'file', projectId: 'p', relPath: 'ok.txt' },
      { kind: 'file', projectId: 'p', relPath: '../../etc/passwd' },
      { kind: 'file', projectId: 'p', relPath: '/etc/passwd' },
      { kind: 'file', projectId: 'p', relPath: 'a\nb' },
      { kind: 'link', projectId: 'p', relPath: 'x' },
      { kind: 'file', projectId: '', relPath: 'x' },
      { kind: 'file', projectId: 'p\u001b', relPath: 'x' },
      { kind: 'file', projectId: 'p', relPath: 'x', absPath: 5 },
      { kind: 'file', projectId: 5, relPath: 'x' },
      null, 7, 'str',
    ];
    const parsed = parsePathPayload(JSON.stringify({ items }))!;
    expect(parsed.items.map((i) => i.relPath)).toEqual(['ok.txt']);
    expect(parsed.rejected).toBe(items.length - 1);
  });

  it('drops duplicates and caps the number of items', () => {
    const dup = parsePathPayload(JSON.stringify({ items: [{ kind: 'file', projectId: 'p', relPath: 'a' }, { kind: 'file', projectId: 'p', relPath: 'a' }] }))!;
    expect(dup.items).toHaveLength(1);
    const many = Array.from({ length: MAX_DROP_ITEMS + 20 }, (_, i) => ({ kind: 'file', projectId: 'p', relPath: `f${i}` }));
    const parsed = parsePathPayload(JSON.stringify({ items: many }))!;
    expect(parsed.items).toHaveLength(MAX_DROP_ITEMS);
    expect(parsed.rejected).toBe(20);
    const built = buildPathPayload('p', '/r', many.map((m) => ({ relPath: m.relPath, kind: 'file' as const })), 'linux');
    expect(JSON.parse(built).items).toHaveLength(MAX_DROP_ITEMS);
  });
});

describe('cells that cannot take a drop', () => {
  const ok = { held: false, error: false, started: true, status: 'waiting' as const };
  it('names the reason', () => {
    expect(dropBlock(ok)).toBeNull();
    expect(dropBlock({ ...ok, status: 'working' })).toBeNull();
    expect(dropBlock({ ...ok, status: 'idle' })).toBeNull();
    expect(dropBlock({ ...ok, held: true })).toBe('held');
    expect(dropBlock({ ...ok, error: true })).toBe('error');
    expect(dropBlock({ ...ok, started: false })).toBe('starting');
    expect(dropBlock({ ...ok, status: 'exited' })).toBe('exited');
  });
});
