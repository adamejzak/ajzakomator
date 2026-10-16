// test/accounts-reconcile.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareIdentity, custodyOf, type AccountIdentity } from '../src/shared/accounts';
import { reconcileLive, type ReconcileDeps } from '../src/main/accounts/reconcile';
import { resyncActiveBackup } from '../src/main/accounts/resync';
import { AccountsStore } from '../src/main/accounts/store';

const G = { email: 'g@x.com', accountUuid: 'ug' };
const A = { email: 'a@x.com', accountUuid: 'ua' };
let root: string;
let home: string;
let store: AccountsStore;
let live: AccountIdentity | null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ajza-reconcile-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  store = new AccountsStore(join(root, 'accounts'));
  live = null;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (resync?: ReconcileDeps['resync']): ReconcileDeps => ({ store, readLiveIdentity: async () => live, now: () => 10, ...(resync ? { resync } : {}) });
const add = (identity: AccountIdentity, custody?: 'app' | 'live') => { const { id } = store.prepare(); store.commit({ id, addedAt: 1, ...identity, ...(custody ? { custody } : {}) }); return id; };
const holders = (identity: AccountIdentity) => store.list().filter((r) => custodyOf(r) !== 'quarantined' && compareIdentity(r, identity) === 'same');

describe('reconcileLive', () => {
  it('adopts an unknown live account as a record, once', async () => {
    live = A;
    const first = await reconcileLive(deps());
    expect(first.changed).toBe(true);
    expect(holders(A)).toHaveLength(1);
    expect(store.get(first.activeId!)).toMatchObject({ ...A, custody: 'live', family: 'live' });
    expect(store.notices().map((n) => n.kind)).toEqual(['adopted']);
    expect(await reconcileLive(deps())).toEqual({ activeId: first.activeId, changed: false });
  });

  it('main changes from G to A while a saved P holds A: P becomes live, G foreign, one card for A (investigation test 3)', async () => {
    const g = add(G, 'live');
    const p = add(A);
    store.setLive({ ...G, recordId: g });
    live = A;
    const result = await reconcileLive(deps());
    expect(result.activeId).toBe(p);
    expect(store.get(p)?.custody).toBe('live');
    expect(store.get(g)?.custody).toBe('foreign');
    expect(holders(A)).toHaveLength(1);
    expect(store.notices()).toEqual([expect.objectContaining({ kind: 'switchedOut', email: 'g@x.com', recordId: g })]);
    expect(store.live()).toEqual({ ...A, recordId: p });
  });

  it('main changes from A to G externally: G is adopted, A is kept and nothing is deleted (investigation test 4)', async () => {
    const a = add(A, 'live');
    store.setLive({ ...A, recordId: a });
    live = G;
    await reconcileLive(deps());
    expect(store.get(a)?.custody).toBe('foreign');
    expect(existsSync(store.dirOf(a))).toBe(true);
    expect(holders(G)).toHaveLength(1);
  });

  it('a sign-out outside the app keeps the record and says so', async () => {
    const a = add(A, 'live');
    store.setLive({ ...A, recordId: a });
    await reconcileLive(deps());
    expect(store.get(a)?.custody).toBe('foreign');
    expect(store.notices()[0].kind).toBe('loggedOut');
    expect(store.live()).toBeNull();
  });

  it('an own change (the app signed in someone else) leaves the outgoing record renewable and silent', async () => {
    const a = add(A, 'live');
    live = G;
    await reconcileLive(deps(), { ownChange: true });
    expect(store.get(a)?.custody).toBe('app');
    expect(store.notices().map((n) => n.kind)).toEqual(['adopted']);
  });

  it('sets a second record of the live account aside instead of keeping two cards', async () => {
    const p = add(A, 'live');
    const copy = add(A);
    live = A;
    await reconcileLive(deps());
    expect(store.get(copy)).toMatchObject({ custody: 'quarantined', duplicateOf: p });
  });

  it('fills the uuids from the live login and resyncs the active record; a failing resync changes nothing else', async () => {
    const p = add({ email: 'a@x.com' }, 'live');
    live = A;
    const resync = vi.fn(async () => { throw new Error('disk'); });
    await reconcileLive(deps(resync));
    expect(store.get(p)?.accountUuid).toBe('ua');
    expect(resync).toHaveBeenCalledWith(p, A);
  });

  it('prefers the record the live login already names over an older record of the same account', async () => {
    const older = add(A);
    const named = add(A, 'live');
    store.setLive({ ...A, recordId: named });
    live = A;
    const result = await reconcileLive(deps());
    expect(result.activeId).toBe(named);
    expect(store.get(older)).toMatchObject({ custody: 'quarantined', duplicateOf: named });
    expect(store.notices().map((n) => n.kind)).toEqual(['quarantined']);
  });

  it('writes nothing and throws nothing while accounts.json is read-only', async () => {
    const a = add(A, 'live');
    store.setLive({ ...A, recordId: a });
    const file = join(root, 'accounts', 'accounts.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...parsed, version: 99 }));
    const before = readFileSync(file, 'utf8');
    live = G;
    const resync = vi.fn(async () => 'copied' as const);
    expect(store.readOnly()).toBe(true);
    expect(await reconcileLive(deps(resync))).toEqual({ activeId: a, changed: false });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(resync).not.toHaveBeenCalled();
  });

  it('changes nothing when the live identity cannot be read', async () => {
    add(A, 'live');
    const result = await reconcileLive({ ...deps(), readLiveIdentity: async () => { throw new Error('io'); } });
    expect(result.changed).toBe(false);
  });
});

describe('resyncActiveBackup', () => {
  const paths = () => ({ credentials: join(home, '.claude', '.credentials.json'), claudeJson: join(home, '.claude.json') });
  const putLive = (identity: { emailAddress: string; accountUuid: string }, n: string) => {
    writeFileSync(paths().credentials, JSON.stringify({ claudeAiOauth: { accessToken: `fake-acc-${n}`, refreshToken: `fake-ref-${n}`, expiresAt: 5 }, mcpOAuth: { s: 1 } }));
    writeFileSync(paths().claudeJson, JSON.stringify({ oauthAccount: identity, projects: {} }));
  };
  const rdeps = () => ({ paths: paths(), store, delay: async () => undefined, locks: { timeoutMs: 300 } });

  it('copies the live tokens into the record, keeps other keys, marks the family live; unchanged the second time', async () => {
    const p = add(A, 'live');
    mkdirSync(store.dirOf(p), { recursive: true });
    writeFileSync(join(store.dirOf(p), '.credentials.json'), JSON.stringify({ other: 1, claudeAiOauth: { accessToken: 'old', refreshToken: 'old' } }));
    putLive({ emailAddress: 'a@x.com', accountUuid: 'ua' }, '1');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('copied');
    const copied = JSON.parse(readFileSync(join(store.dirOf(p), '.credentials.json'), 'utf8'));
    expect(copied).toEqual({ other: 1, claudeAiOauth: { accessToken: 'fake-acc-1', refreshToken: 'fake-ref-1', expiresAt: 5 } });
    expect(JSON.parse(readFileSync(join(store.dirOf(p), '.claude.json'), 'utf8')).oauthAccount.accountUuid).toBe('ua');
    expect(store.get(p)?.family).toBe('live');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('unchanged');
  });

  it("never copies a login whose identity is not the record's", async () => {
    const p = add(A, 'live');
    putLive({ emailAddress: 'g@x.com', accountUuid: 'ug' }, '2');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('mismatch');
    expect(existsSync(join(store.dirOf(p), '.credentials.json'))).toBe(false);
  });

  it("waits for Claude Code's credential lock and gives up without writing", async () => {
    const p = add(A, 'live');
    putLive({ emailAddress: 'a@x.com', accountUuid: 'ua' }, '3');
    mkdirSync(join(home, '.claude', '.oauth_refresh.lock'));
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('locked');
    expect(existsSync(join(store.dirOf(p), '.credentials.json'))).toBe(false);
  });

  it('reports a missing live login', async () => {
    const p = add(A, 'live');
    expect(await resyncActiveBackup(rdeps(), p, A)).toBe('missing');
  });
});
