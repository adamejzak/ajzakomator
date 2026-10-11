// test/accounts-store.test.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAccountId } from '../src/shared/accounts';
import { AccountsStore } from '../src/main/accounts/store';

let base: string;
let root: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ajza-acc-')); root = join(base, 'accounts'); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

const BAD_IDS = ['', '../x', 'a/b', 'not-a-uuid', '..', '00000000-0000-0000-0000-00000000000G', '../../00000000-0000-0000-0000-000000000000'];

describe('isAccountId', () => {
  it('accepts uuids only', () => {
    expect(isAccountId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    for (const bad of BAD_IDS) expect(isAccountId(bad)).toBe(false);
    expect(isAccountId(5)).toBe(false);
    expect(isAccountId(undefined)).toBe(false);
  });
});

describe('AccountsStore', () => {
  it('prepare creates the directory but does not list it', () => {
    const store = new AccountsStore(root);
    const { id, dir } = store.prepare();
    expect(isAccountId(id)).toBe(true);
    expect(dir).toBe(join(root, 'claude', id));
    expect(existsSync(dir)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('commit lists the account and persists across instances, in insertion order', () => {
    const store = new AccountsStore(root);
    const a = store.prepare().id;
    const b = store.prepare().id;
    store.commit({ id: b, email: 'b@x.com', addedAt: 2 });
    store.commit({ id: a, email: 'a@x.com', org: 'Org', addedAt: 1 });
    const again = new AccountsStore(root).list();
    expect(again.map((x) => x.id)).toEqual([b, a]);
    expect(again[1]).toEqual({ id: a, email: 'a@x.com', org: 'Org', addedAt: 1 });
  });

  it('commit of an existing id replaces it', () => {
    const store = new AccountsStore(root);
    const { id } = store.prepare();
    store.commit({ id, email: 'old@x.com', addedAt: 1 });
    store.commit({ id, email: 'new@x.com', addedAt: 3 });
    expect(store.list()).toEqual([{ id, email: 'new@x.com', addedAt: 3 }]);
  });

  it('tolerates missing and corrupt files', () => {
    expect(new AccountsStore(root).list()).toEqual([]);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'accounts.json'), '{not json');
    expect(new AccountsStore(root).list()).toEqual([]);
    writeFileSync(join(root, 'accounts.json'), '[1,2]');
    expect(new AccountsStore(root).list()).toEqual([]);
    writeFileSync(join(root, 'accounts.json'), JSON.stringify({ claude: 'x' }));
    expect(new AccountsStore(root).list()).toEqual([]);
  });

  it('drops entries with bad ids or shapes', () => {
    mkdirSync(root, { recursive: true });
    const good = '123e4567-e89b-42d3-a456-426614174000';
    writeFileSync(join(root, 'accounts.json'), JSON.stringify({ claude: [
      { id: '../x', addedAt: 1 },
      { id: good, addedAt: 'x' },
      null, 7,
      { id: good, addedAt: 5, email: 'ok@x.com', org: 3 },
      { id: '223e4567-e89b-42d3-a456-426614174000', addedAt: 6, email: 'e'.repeat(121) },
    ] }));
    expect(new AccountsStore(root).list()).toEqual([
      { id: good, addedAt: 5, email: 'ok@x.com' },
      { id: '223e4567-e89b-42d3-a456-426614174000', addedAt: 6 },
    ]);
  });

  it('update changes email and org', () => {
    const store = new AccountsStore(root);
    const { id } = store.prepare();
    store.commit({ id, addedAt: 1 });
    store.update(id, { email: 'u@x.com', org: 'O' });
    expect(new AccountsStore(root).list()).toEqual([{ id, email: 'u@x.com', org: 'O', addedAt: 1 }]);
    store.update('123e4567-e89b-42d3-a456-426614174000', { email: 'z' });
    store.update('../x', { email: 'z' });
    expect(store.list()).toHaveLength(1);
  });

  it('remove deletes the record and directory, also for an uncommitted id', () => {
    const store = new AccountsStore(root);
    const a = store.prepare();
    store.commit({ id: a.id, addedAt: 1 });
    const b = store.prepare();
    store.remove(a.id);
    store.remove(b.id);
    expect(store.list()).toEqual([]);
    expect(existsSync(a.dir)).toBe(false);
    expect(existsSync(b.dir)).toBe(false);
  });

  it('rejects invalid ids and never touches anything outside the root', () => {
    const store = new AccountsStore(root);
    store.prepare();
    const sibling = join(base, 'keep.txt');
    writeFileSync(sibling, 'x');
    mkdirSync(join(root, 'claude', 'x'), { recursive: true });
    for (const bad of BAD_IDS) {
      expect(() => store.dirOf(bad)).toThrow('invalid account id');
      expect(() => store.remove(bad)).not.toThrow();
    }
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(join(root, 'claude', 'x'))).toBe(true);
    expect(existsSync(base)).toBe(true);
  });

  it('writes atomically and leaves no temp files', () => {
    const store = new AccountsStore(root);
    const { id } = store.prepare();
    store.commit({ id, addedAt: 1 });
    store.update(id, { email: 'a@x.com' });
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(root)).toContain('accounts.json');
  });
});
