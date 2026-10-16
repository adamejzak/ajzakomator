// test/accounts-store.test.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAccountId } from '../src/shared/accounts';
import { AccountsStore } from '../src/main/accounts/store';

let base: string;
let root: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ajza-acc-')); root = join(base, 'accounts'); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

const BAD_IDS = ['', '../x', 'a/b', 'not-a-uuid', '..', '00000000-0000-0000-0000-00000000000G', '../../00000000-0000-0000-0000-000000000000', '123E4567-E89B-42D3-A456-426614174000', '123e4567-e89b-42d3-a456-426614174000\n'];

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

  it('drops over-long email and org on commit and update like list does', () => {
    const store = new AccountsStore(root);
    const { id } = store.prepare();
    store.commit({ id, email: 'x'.repeat(121), org: 'Org', addedAt: 1 });
    expect(store.list()).toEqual([{ id, org: 'Org', addedAt: 1 }]);
    store.update(id, { email: 'y'.repeat(200), org: 'o'.repeat(121) });
    expect(store.list()).toEqual([{ id, addedAt: 1 }]);
    store.update(id, { email: 'ok@x.com' });
    expect(store.list()).toEqual([{ id, email: 'ok@x.com', addedAt: 1 }]);
  });

  it('keeps a corrupt accounts.json as .bak before overwriting it', () => {
    const store = new AccountsStore(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'accounts.json'), '{not json');
    const { id } = store.prepare();
    store.commit({ id, addedAt: 1 });
    expect(readFileSync(join(root, 'accounts.json.bak'), 'utf8')).toBe('{not json');
    expect(store.list()).toEqual([{ id, addedAt: 1 }]);
  });

  it('removes the temp file when the write cannot be completed', () => {
    const store = new AccountsStore(root);
    const { id } = store.prepare();
    mkdirSync(join(root, 'accounts.json'));
    expect(() => store.commit({ id, addedAt: 1 })).toThrow();
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
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

describe('AccountsStore.update', () => {
  it('keeps the key order of the stored entry', () => {
    const store = new AccountsStore(root);
    const id = '123e4567-e89b-42d3-a456-426614174000';
    store.commit({ id, email: 'a@x.com', org: 'Org', addedAt: 5 });
    const keys = () => Object.keys(JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')).claude[0]);
    const before = keys();
    store.update(id, { org: 'Other', email: 'b@x.com' });
    expect(keys()).toEqual(before);
    store.update(id, { org: undefined });
    expect(store.list()[0]).toEqual({ id, email: 'b@x.com', addedAt: 5 });
  });
});

describe('AccountsStore v2', () => {
  const ID = '123e4567-e89b-42d3-a456-426614174000';
  const OTHER = '223e4567-e89b-42d3-a456-426614174000';
  it('keeps identity, custody, family and duplicateOf and drops bad values', () => {
    const store = new AccountsStore(root);
    store.commit({ id: ID, addedAt: 1, email: 'a@x.com', accountUuid: 'u1', organizationUuid: 'o1', custody: 'live', family: 'own' });
    store.commit({ id: OTHER, addedAt: 2, custody: 'weird' as never, family: 'x' as never, duplicateOf: '../x' });
    expect(store.list()).toEqual([
      { id: ID, addedAt: 1, email: 'a@x.com', accountUuid: 'u1', organizationUuid: 'o1', custody: 'live', family: 'own' },
      { id: OTHER, addedAt: 2 },
    ]);
    store.setCustody(OTHER, 'quarantined', ID);
    store.setFamily(OTHER, 'live');
    store.updateIdentity(OTHER, { email: 'b@x.com', accountUuid: 'u2' });
    expect(store.get(OTHER)).toEqual({ id: OTHER, addedAt: 2, email: 'b@x.com', accountUuid: 'u2', custody: 'quarantined', family: 'live', duplicateOf: ID });
  });
  it('updateIdentity with replace takes exactly the given identity', () => {
    const store = new AccountsStore(root);
    store.commit({ id: ID, addedAt: 1, email: 'a@x.com', org: 'Acme', accountUuid: 'u1', organizationUuid: 'o1', custody: 'live' });
    store.updateIdentity(ID, { email: 'b@x.com', accountUuid: 'u2' }, { replace: true });
    expect(store.get(ID)).toEqual({ id: ID, addedAt: 1, email: 'b@x.com', accountUuid: 'u2', custody: 'live' });
  });
  it('reports version 1 for a 0.9.0 file and 2 after the migration mark', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'accounts.json'), JSON.stringify({ claude: [{ id: ID, addedAt: 1, email: 'a@x.com' }] }));
    const store = new AccountsStore(root);
    expect(store.version()).toBe(1);
    store.markMigrated();
    expect(store.version()).toBe(2);
    expect(store.list()).toEqual([{ id: ID, addedAt: 1, email: 'a@x.com' }]);
  });
  it('keeps the live identity and the notices across record writes, at most 20 notices', () => {
    const store = new AccountsStore(root);
    store.setLive({ email: 'a@x.com', accountUuid: 'u1', recordId: ID });
    for (let i = 0; i < 25; i++) store.addNotice({ kind: 'switchedOut', at: i, email: `n${i}@x.com` });
    store.commit({ id: ID, addedAt: 1 });
    expect(store.live()).toEqual({ email: 'a@x.com', accountUuid: 'u1', recordId: ID });
    const notices = store.notices();
    expect(notices).toHaveLength(20);
    expect(notices[0].email).toBe('n5@x.com');
    store.dismissNotice(notices[0].id);
    expect(store.notices()).toHaveLength(19);
    store.setLive(null);
    expect(store.live()).toBeNull();
  });
  it('remove drops the notices and the live record id that point to the record', () => {
    const store = new AccountsStore(root);
    const { id } = store.prepare();
    store.commit({ id, addedAt: 1 });
    store.setLive({ email: 'a@x.com', recordId: id });
    store.addNotice({ kind: 'quarantined', at: 1, recordId: id });
    store.remove(id);
    expect(store.notices()).toEqual([]);
    expect(store.live()).toEqual({ email: 'a@x.com' });
  });
});
