// The renderer file store with a stubbed window: open tabs after a rename while another tab loads and one is saving.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { documentId } from '../src/shared/fileOps';

// The renderer is not part of the node tsconfig: load it dynamically and describe only what is used here.
interface TestDoc { id: string; text: string; saving: boolean; status: string; error: string | null; relativePath: string; savedText: string }
let files: any;
let readCalls: string[] = [];
let releaseWrite: () => void = () => undefined;
let releaseRead: () => void = () => undefined;

beforeAll(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
  vi.stubGlobal('window', {
    mc: {
      platform: 'linux',
      readProjectFile: (_project: string, path: string) => { readCalls.push(path); return new Promise((resolve) => { releaseRead = () => resolve({ kind: 'text', text: `disk ${path}`, size: 5, truncated: false }); }); },
      writeProjectFile: () => new Promise((resolve) => { releaseWrite = () => resolve({ ok: true }); }),
    },
    setTimeout, clearTimeout,
  });
  const modulePath = '../src/renderer/src/files';
  files = await import(/* @vite-ignore */ modulePath);
});

const doc = (path: string, extra: Record<string, unknown> = {}) => ({
  id: documentId('p', path), projectId: 'p', relativePath: path, name: path.split('/').pop()!,
  text: 'text', savedText: 'text', diskText: 'text', status: 'ready' as const, saving: false, error: null, wrap: false, ...extra,
});

describe('retargetOpenFiles', () => {
  it('only touches the renamed tabs: an unrelated loading tab keeps its load, a saving tab finishes saving under its new id', async () => {
    readCalls = [];
    const loading = doc('other/loading.txt', { status: 'loading', text: '', savedText: '', diskText: '' });
    const saving = doc('a/old.txt', { text: 'edited', savedText: 'text' });
    files.useFileStore.setState({ documents: [loading, saving], activeFileId: saving.id });
    const savePromise = files.saveFile(saving.id);
    await Promise.resolve();
    expect(files.useFileStore.getState().documents.find((d: TestDoc) => d.id === saving.id)?.saving).toBe(true);

    // a load of the unrelated tab is in flight
    void files.retryFile(loading.id);
    await Promise.resolve();
    expect(readCalls).toEqual(['other/loading.txt']);
    const unrelatedRelease = releaseRead;

    files.retargetOpenFiles('p', [{ from: 'a', to: 'b' }]);
    const state = files.useFileStore.getState();
    const renamed = state.documents.find((d: TestDoc) => d.relativePath === 'b/old.txt')!;
    expect(renamed).toMatchObject({ id: documentId('p', 'b/old.txt'), saving: true, text: 'edited' });
    expect(state.activeFileId).toBe(renamed.id);

    // the unrelated load still lands on its tab (its token was not cleared) and no second read was started for it
    unrelatedRelease();
    await vi.waitFor(() => expect(files.useFileStore.getState().documents.find((d: TestDoc) => d.id === loading.id)?.status).toBe('ready'));
    expect(readCalls).toEqual(['other/loading.txt']);

    // the save that started under the old id completes: the renamed tab is no longer stuck in saving
    releaseWrite();
    expect(await savePromise).toBe(true);
    const after = files.useFileStore.getState().documents.find((d: TestDoc) => d.id === renamed.id)!;
    expect(after.saving).toBe(false);
    expect(after.savedText).toBe('edited');
    // and it can be closed (closeFile refuses while saving)
    expect(await files.closeFile(renamed.id)).toBe(true);
  });

  it('keeps a dirty tab of a replaced file, marked, and closes the clean one', () => {
    const moved = doc('a/x.txt');
    const dirty = doc('c/x.txt', { text: 'unsaved', savedText: 'text' });
    files.useFileStore.setState({ documents: [moved, dirty], activeFileId: dirty.id });
    files.retargetOpenFiles('p', [{ from: 'a/x.txt', to: 'c/x.txt' }], ['c/x.txt']);
    const state = files.useFileStore.getState();
    expect(state.documents).toHaveLength(2);
    const kept = state.documents.find((d: TestDoc) => d.text === 'unsaved')!;
    expect(kept.error).toBe('Ten plik został usunięty z dysku. Niezapisany szkic został zachowany.');
    expect(state.activeFileId).toBe(kept.id);
    expect(state.documents.find((d: TestDoc) => d.id === documentId('p', 'c/x.txt'))?.text).toBe('text');
  });
});
