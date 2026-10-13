import { describe, expect, it } from 'vitest';
import {
  copyName, documentId, documentsUnder, hasGitSegment, isSameOrDescendant, removeDocuments, renameSelectionEnd, retargetByMoves,
  retargetDocuments, retargetPath, retargetPathSet, summarizeNames, tabsToClose, topLevelPaths, validateEntryName, validPathList, MAX_OP_PATHS, MAX_OP_PATH_LENGTH, type DocumentLike,
} from '../src/shared/fileOps';
import { revealScroll, scrollEdges, stepScroll, wheelScroll } from '../src/shared/tabStrip';

const doc = (path: string, extra: Record<string, unknown> = {}): DocumentLike & Record<string, unknown> =>
  ({ id: documentId('p', path), projectId: 'p', relativePath: path, name: path.split('/').pop()!, text: 'draft', ...extra });

describe('path helpers', () => {
  it('retargets paths below a moved folder only', () => {
    expect(retargetPath('src/a.ts', 'src', 'lib')).toBe('lib/a.ts');
    expect(retargetPath('src', 'src', 'lib/src')).toBe('lib/src');
    expect(retargetPath('src2/a.ts', 'src', 'lib')).toBeNull();
    expect(retargetPath('a.ts', '', 'x')).toBeNull();
    expect(retargetByMoves('a/b/c.ts', [{ from: 'a', to: 'x' }, { from: 'a/b', to: 'y' }])).toBe('y/c.ts');
    expect(retargetPathSet(['a', 'a/b', 'z'], [{ from: 'a', to: 'q' }])).toEqual(['q', 'q/b', 'z']);
  });
  it('knows descendants, git segments and top-level selections', () => {
    expect(isSameOrDescendant('a', 'a/b')).toBe(true);
    expect(isSameOrDescendant('a', 'ab')).toBe(false);
    expect(isSameOrDescendant('', 'anything')).toBe(true);
    expect(hasGitSegment('x/.git/config')).toBe(true);
    expect(hasGitSegment('x/.github/ci.yml')).toBe(false);
    expect(topLevelPaths(['a/b', 'a', 'c', 'c'])).toEqual(['a', 'c']);
  });
  it('validates names for every platform', () => {
    expect(validateEntryName('ok.txt', 'win32')).toBeNull();
    expect(validateEntryName('', 'linux')).toBeTruthy();
    expect(validateEntryName('a/b', 'linux')).toBeTruthy();
    expect(validateEntryName('a\\b', 'win32')).toBeTruthy();
    expect(validateEntryName('a\\b', 'linux')).toBeNull();
    expect(validateEntryName('con.txt', 'win32')).toBeTruthy();
    expect(validateEntryName('console.txt', 'win32')).toBeNull();
    expect(validateEntryName('x.', 'win32')).toBeTruthy();
    expect(validateEntryName('x ', 'win32')).toBeTruthy();
    expect(validateEntryName('x.', 'darwin')).toBeNull();
    expect(validateEntryName('a'.repeat(256), 'linux')).toBeTruthy();
  });
  it('builds copy names', () => {
    expect(copyName('a.txt', 1, false)).toBe('a copy.txt');
    expect(copyName('a.txt', 2, false)).toBe('a copy 2.txt');
    expect(copyName('a copy.txt', 1, false)).toBe('a copy.txt');
    expect(copyName('a copy 2.txt', 3, false)).toBe('a copy 3.txt');
    expect(copyName('.env', 1, false)).toBe('.env copy');
    expect(copyName('v1.2', 1, true)).toBe('v1.2 copy');
    expect(copyName('archive.tar.gz', 1, false)).toBe('archive.tar copy.gz');
  });
  it('selects the stem when renaming', () => {
    expect(renameSelectionEnd('index.ts', false)).toBe(5);
    expect(renameSelectionEnd('.env', false)).toBe(4);
    expect(renameSelectionEnd('v1.2', true)).toBe(4);
    expect(summarizeNames(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], more: 1 });
  });
});

describe('open tabs follow renames, moves and deletes', () => {
  it('renames a file tab and keeps its draft and the active selection', () => {
    const docs = [doc('a.txt', { text: 'edited' }), doc('b.txt')];
    const result = retargetDocuments(docs, docs[0].id, 'p', [{ from: 'a.txt', to: 'z.txt' }]);
    expect(result.documents.map((d) => d.relativePath)).toEqual(['z.txt', 'b.txt']);
    expect(result.documents[0]).toMatchObject({ id: documentId('p', 'z.txt'), name: 'z.txt', text: 'edited' });
    expect(result.activeId).toBe(documentId('p', 'z.txt'));
    expect(result.documents[1]).toBe(docs[1]);
  });
  it('follows a renamed or moved parent folder', () => {
    const docs = [doc('src/a.ts'), doc('src/deep/b.ts'), doc('other/c.ts')];
    const result = retargetDocuments(docs, docs[1].id, 'p', [{ from: 'src', to: 'lib/src' }]);
    expect(result.documents.map((d) => d.relativePath)).toEqual(['lib/src/a.ts', 'lib/src/deep/b.ts', 'other/c.ts']);
    expect(result.activeId).toBe(documentId('p', 'lib/src/deep/b.ts'));
  });
  it('ignores other projects and untouched files', () => {
    const other = { ...doc('a.txt'), projectId: 'q', id: documentId('q', 'a.txt') };
    const docs = [other, doc('b.txt')];
    const result = retargetDocuments(docs, null, 'p', [{ from: 'a.txt', to: 'z.txt' }]);
    expect(result.changed).toBe(false);
    expect(result.documents).toBe(docs);
  });
  it('a moved tab replaces a tab on the overwritten target', () => {
    const docs = [doc('docs/a.txt', { text: 'old' }), doc('a.txt', { text: 'new' })];
    const result = retargetDocuments(docs, docs[0].id, 'p', [{ from: 'a.txt', to: 'docs/a.txt' }]);
    expect(result.documents.map((d) => d.text)).toEqual(['new']);
    expect(result.activeId).toBe(documentId('p', 'docs/a.txt'));
  });
  it('swaps two files at once', () => {
    const docs = [doc('a'), doc('b')];
    const result = retargetDocuments(docs, null, 'p', [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
    expect(result.documents.map((d) => d.relativePath).sort()).toEqual(['a', 'b']);
    expect(result.documents.map((d) => d.relativePath)).toEqual(['b', 'a']);
  });
  it('finds and removes tabs of deleted paths, moving the active tab to a neighbour', () => {
    const docs = [doc('x/a.ts'), doc('b.ts'), doc('x/c.ts')];
    const ids = documentsUnder(docs, 'p', ['x']);
    expect(ids).toEqual([docs[0].id, docs[2].id]);
    const rest = removeDocuments(docs, docs[2].id, ids);
    expect(rest.documents.map((d) => d.relativePath)).toEqual(['b.ts']);
    expect(rest.activeId).toBe(docs[1].id);
    expect(removeDocuments(docs, docs[1].id, ids).activeId).toBe(docs[1].id);
    expect(removeDocuments(docs, docs[0].id, docs.map((d) => d.id)).activeId).toBeNull();
  });
});

describe('tab menus', () => {
  const order = ['file:1', 'file:2', 'file:3', 'file:4'];
  it('computes the tabs for Close others / to the right / all', () => {
    expect(tabsToClose(order, 'file:2', 'others')).toEqual(['file:1', 'file:3', 'file:4']);
    expect(tabsToClose(order, 'file:2', 'right')).toEqual(['file:3', 'file:4']);
    expect(tabsToClose(order, 'file:4', 'right')).toEqual([]);
    expect(tabsToClose(order, 'file:2', 'all')).toEqual(order);
    expect(tabsToClose(order, 'gone', 'right')).toEqual([]);
  });
});

describe('tab strip scrolling', () => {
  it('shows arrows only where there is more to scroll', () => {
    expect(scrollEdges(0, 500, 500)).toEqual({ canLeft: false, canRight: false });
    expect(scrollEdges(0, 500, 2000)).toEqual({ canLeft: false, canRight: true });
    expect(scrollEdges(300, 500, 2000)).toEqual({ canLeft: true, canRight: true });
    expect(scrollEdges(1500, 500, 2000)).toEqual({ canLeft: true, canRight: false });
    expect(scrollEdges(1499.6, 500, 2000)).toEqual({ canLeft: true, canRight: false });
  });
  it('scrolls the active tab into view with padding and leaves visible tabs alone', () => {
    const view = { scrollLeft: 0, width: 500, scrollWidth: 4000 };
    expect(revealScroll(view, { left: 100, width: 200 })).toBe(0);
    expect(revealScroll(view, { left: 600, width: 200 })).toBe(600 + 200 + 28 - 500);
    expect(revealScroll({ ...view, scrollLeft: 1000 }, { left: 200, width: 200 })).toBe(172);
    expect(revealScroll({ ...view, scrollLeft: 1000 }, { left: 1100, width: 200 })).toBe(1000);
    expect(revealScroll({ ...view, scrollLeft: 3500 }, { left: 3900, width: 200 })).toBe(3500);
    expect(revealScroll({ ...view, scrollLeft: 100 }, { left: 10, width: 100 })).toBe(0);
  });
  it('steps by most of the visible width and maps wheel events to horizontal pixels', () => {
    expect(stepScroll(1, 500)).toBe(300);
    expect(stepScroll(-1, 100)).toBe(-120);
    expect(wheelScroll({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 500)).toBe(100);
    expect(wheelScroll({ deltaX: 40, deltaY: 5, deltaMode: 0 }, 500)).toBe(40);
    expect(wheelScroll({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 500)).toBe(120);
    expect(wheelScroll({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 500)).toBe(500);
  });
});

describe('retargeting never loses unsaved text', () => {
  const dirty = (d: { text?: unknown }) => d.text === 'unsaved';

  it('keeps a dirty tab on a replaced target as a detached tab (reviewer repro)', () => {
    const docs = [doc('a/x.txt'), doc('c/x.txt', { text: 'unsaved' })];
    const result = retargetDocuments(docs, docs[1].id, 'p', [{ from: 'a/x.txt', to: 'c/x.txt' }], { isDirty: dirty, replaced: ['c/x.txt'] });
    expect(result.documents).toHaveLength(2);
    const moved = result.documents.find((d) => d.id === documentId('p', 'c/x.txt'))!;
    const detached = result.documents.find((d) => d.text === 'unsaved')!;
    expect(moved.relativePath).toBe('c/x.txt');
    expect(moved.text).toBe('draft');
    expect(detached.id).not.toBe(documentId('p', 'c/x.txt'));
    expect(result.detached).toEqual([detached.id]);
    expect(result.activeId).toBe(detached.id);
    expect(result.idMap.get(docs[0].id)).toBe(documentId('p', 'c/x.txt'));
    expect(result.idMap.get(docs[1].id)).toBe(detached.id);
  });

  it('closes a clean stale tab and keeps the active one pointing at something sensible', () => {
    const docs = [doc('a/x.txt'), doc('c/x.txt')];
    const result = retargetDocuments(docs, docs[1].id, 'p', [{ from: 'a/x.txt', to: 'c/x.txt' }], { isDirty: dirty, replaced: ['c/x.txt'] });
    expect(result.documents.map((d) => d.relativePath)).toEqual(['c/x.txt']);
    expect(result.closed).toEqual([docs[1].id]);
    expect(result.activeId).toBe(documentId('p', 'c/x.txt'));
  });

  it('handles tabs inside a replaced folder: dirty ones stay, clean ones close', () => {
    const docs = [doc('new/n.txt'), doc('old/keep.txt', { text: 'unsaved' }), doc('old/gone.txt'), doc('other/o.txt')];
    const result = retargetDocuments(docs, null, 'p', [{ from: 'new', to: 'old' }], { isDirty: dirty, replaced: ['old'] });
    expect(result.documents.map((d) => d.relativePath).sort()).toEqual(['old/keep.txt', 'old/n.txt', 'other/o.txt']);
    expect(result.documents.find((d) => d.text === 'unsaved')!.id).not.toBe(documentId('p', 'old/keep.txt'));
    expect(result.closed).toEqual([docs[2].id]);
  });

  it('works for replaced paths without any move (copy) and keeps ids stable otherwise', () => {
    const docs = [doc('c/x.txt', { text: 'unsaved' }), doc('d.txt')];
    const result = retargetDocuments(docs, null, 'p', [], { isDirty: dirty, replaced: ['c/x.txt'] });
    expect(result.documents).toHaveLength(2);
    expect(result.detached).toHaveLength(1);
    expect(retargetDocuments(docs, null, 'p', [], { isDirty: dirty, replaced: [] }).changed).toBe(false);
  });

  it('two sources moved into one folder map to their own final paths', () => {
    const docs = [doc('a/x.txt'), doc('b/x.txt')];
    const result = retargetDocuments(docs, docs[0].id, 'p', [{ from: 'a/x.txt', to: 'c/x.txt' }, { from: 'b/x.txt', to: 'c/x copy.txt' }]);
    expect(result.documents.map((d) => d.relativePath)).toEqual(['c/x.txt', 'c/x copy.txt']);
    expect(result.activeId).toBe(documentId('p', 'c/x.txt'));
  });
});

describe('bounded input helpers', () => {
  it('topLevelPaths is linear and keeps the order', () => {
    expect(topLevelPaths(['a-b', 'a', 'a/c', 'a-b/d', 'z/y', 'z'])).toEqual(['a-b', 'a', 'z']);
    const many = Array.from({ length: 50000 }, (_, i) => `d${i % 100}/f${i}`);
    const started = Date.now();
    expect(topLevelPaths(many)).toHaveLength(50000);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('validates path lists', () => {
    expect(validPathList(['a'])).toBe(true);
    expect(validPathList([])).toBe(false);
    expect(validPathList('a')).toBe(false);
    expect(validPathList([1])).toBe(false);
    expect(validPathList(['a'.repeat(MAX_OP_PATH_LENGTH + 1)])).toBe(false);
    expect(validPathList(new Array(MAX_OP_PATHS + 1).fill('a'))).toBe(false);
  });
});
