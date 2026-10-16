import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareIdentity, custodyOf } from '../src/shared/accounts';
import { activateAccount, checkActivationTarget, recoverInterruptedActivation, type ActivateDeps } from '../src/main/accounts/activate';
import type { CswapRoster } from '../src/main/accounts/cswap';
import { reconcileLive } from '../src/main/accounts/reconcile';
import { claudeRefs } from '../src/main/accounts/refs';
import { AccountsStore } from '../src/main/accounts/store';
import { claimSwap, nodeSwapFs, releaseSwap, type SwapFs } from '../src/main/accounts/swap';
import { fetchClaude, type FetcherDeps } from '../src/main/usage/fetchers';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const FUTURE = NOW + 3_600_000;
let root: string;
let home: string;
let store: AccountsStore;
let refresh: ActivateDeps['refresh'];
let roster: CswapRoster;
let fs: SwapFs;
let A: string; // record of the live account a@x.com
let T: string; // target x@x.com

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const put = (path: string, data: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
const liveCreds = () => join(home, '.claude', '.credentials.json');
const liveJson = () => join(home, '.claude.json');
const backupDir = () => join(root, 'accounts', 'swap-backup');
const creds = (n: string, expiresAt = FUTURE) => ({ claudeAiOauth: { accessToken: `fake-acc-${n}`, refreshToken: `fake-ref-${n}`, expiresAt, scopes: ['s'] }, mcpOAuth: { server: n } });
const account = (n: string, email: string) => ({ emailAddress: email, organizationName: `Org ${n}`, accountUuid: `uuid-${n}`, organizationUuid: `org-${n}` });
const deps = (): ActivateDeps => ({ home, env: {}, platform: 'win32', store, backupDir: backupDir(), now: () => NOW, refresh, delay: async () => undefined, cswap: async () => roster, fs, locks: { timeoutMs: 300 } });
const files = () => [liveCreds(), liveJson(), join(store.dirOf(A), '.credentials.json'), join(store.dirOf(A), '.claude.json'), join(store.dirOf(T), '.credentials.json')];
const snapshot = () => files().map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
const lockDirs = () => [join(home, '.claude', '.oauth_refresh.lock'), join(home, '.claude.lock'), join(home, '.claude.json.lock')];

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ajza-activate-'))); // the legacy lock path is realpath-based (native: 8.3 names on CI)
  home = join(root, 'home');
  store = new AccountsStore(join(root, 'accounts'));
  refresh = vi.fn(async () => ({ kind: 'ok' as const }));
  roster = { present: false };
  fs = nodeSwapFs;
  put(liveCreds(), creds('A'));
  put(liveJson(), { oauthAccount: account('A', 'a@x.com'), projects: { p: 1 }, numStartups: 4 });
  A = store.prepare().id;
  store.commit({ id: A, addedAt: 1, email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A', custody: 'live', family: 'live' });
  T = store.prepare().id;
  store.commit({ id: T, addedAt: 2, email: 'x@x.com', accountUuid: 'uuid-X', organizationUuid: 'org-X', custody: 'app', family: 'own' });
  put(join(store.dirOf(T), '.credentials.json'), creds('X'));
  put(join(store.dirOf(T), '.claude.json'), { oauthAccount: account('X', 'x@x.com'), theme: 'dark' });
  store.setLive({ email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A', recordId: A });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('activateAccount', () => {
  it('saves the outgoing live login to its record, writes the target into Claude Code and moves the roles', async () => {
    const result = await activateAccount(deps(), T);
    expect(result).toEqual({ ok: true, email: 'x@x.com' });
    expect(json(liveCreds())).toEqual({ ...creds('X'), mcpOAuth: { server: 'A' } });
    expect(json(liveJson())).toEqual({ oauthAccount: account('X', 'x@x.com'), projects: { p: 1 }, numStartups: 4 });
    expect(json(join(store.dirOf(A), '.credentials.json')).claudeAiOauth).toEqual(creds('A').claudeAiOauth);
    expect(json(join(store.dirOf(A), '.claude.json')).oauthAccount).toEqual(account('A', 'a@x.com'));
    expect(json(join(store.dirOf(T), '.credentials.json'))).toEqual(creds('X')); // the target keeps its copy as a backup
    expect(store.get(A)).toMatchObject({ custody: 'app', family: 'live' });
    expect(store.get(T)).toMatchObject({ custody: 'live' });
    expect(store.live()?.recordId).toBe(T);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
    expect(lockDirs().map(existsSync)).toEqual([false, false, false]);
    expect(JSON.stringify(result)).not.toContain('fake-');
  });

  it('creates a record for an outgoing account the app did not know (a login is never dropped)', async () => {
    store.remove(A);
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    const outgoing = store.list().filter((r) => compareIdentity(r, { accountUuid: 'uuid-A', organizationUuid: 'org-A' }) === 'same');
    expect(outgoing).toHaveLength(1);
    expect(custodyOf(outgoing[0])).toBe('app');
    expect(json(join(store.dirOf(outgoing[0].id), '.credentials.json')).claudeAiOauth.refreshToken).toBe('fake-ref-A');
  });

  it('is not blocked by an unrelated duplicate (investigation test 10)', async () => {
    const dup = store.prepare().id;
    store.commit({ id: dup, addedAt: 3, email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A', custody: 'quarantined', duplicateOf: A });
    expect((await activateAccount(deps(), T)).ok).toBe(true);
  });

  it('does not renew a target whose token is valid for more than 5 minutes', async () => {
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('renews a target that expires in 2 minutes, and reports dead with the e-mail', async () => {
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 2 * 60_000));
    refresh = vi.fn(async () => ({ kind: 'dead' as const }));
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'dead', email: 'x@x.com' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refuses a switched-out target and a copy cswap also holds, but swaps an own family cswap lists', async () => {
    store.setCustody(T, 'foreign');
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    store.setCustody(T, 'app');
    roster = { present: true, accounts: [{ email: 'x@x.com', accountUuid: 'uuid-X' }] };
    store.setFamily(T, 'live');
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    store.setFamily(T, 'own');
    expect((await activateAccount(deps(), T)).ok).toBe(true);
  });

  it("holds Claude Code's locks for every write into Claude Code's files (investigation test 11)", async () => {
    const seen: boolean[] = [];
    fs = { ...nodeSwapFs, rename: async (from, to) => { if (to === liveCreds() || to === liveJson()) seen.push(lockDirs().every(existsSync)); return nodeSwapFs.rename(from, to); } };
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(seen).toEqual([true, true]);
  });

  it('waits on a held lock and aborts cleanly on timeout without writing', async () => {
    const before = snapshot();
    mkdirSync(join(home, '.claude.lock'));
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'locked' });
    expect(snapshot()).toEqual(before);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
    expect(store.list()).toHaveLength(2);
  });

  it('rolls back exactly when writing the live credentials fails', async () => {
    const before = snapshot();
    let failed = false; // fails once: the rollback's own write must go through
    fs = { ...nodeSwapFs, rename: async (from, to) => { if (to === liveCreds() && !failed) { failed = true; throw Object.assign(new Error('boom'), { code: 'EIO' }); } return nodeSwapFs.rename(from, to); } };
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'write' });
    expect(snapshot()).toEqual(before);
    expect(store.get(A)?.custody).toBe('live');
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('renews the target only through the one family rule, and never while holding Claude Code locks', async () => {
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 2 * 60_000));
    const locksDuringRefresh: boolean[] = [];
    refresh = vi.fn(async () => { locksDuringRefresh.push(lockDirs().some(existsSync)); return { kind: 'ok' as const }; });
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    expect(refresh).toHaveBeenCalledWith(store.dirOf(T));
    expect(locksDuringRefresh).toEqual([false]);
  });

  it('never renews or swaps in an expiring target the rule refuses (held by cswap or by the live identity)', async () => {
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW + 2 * 60_000));
    store.setFamily(T, 'live');
    roster = { present: true, accounts: null }; // unreadable roster: holds everything
    const before = snapshot();
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    store.setFamily(T, 'own');
    roster = { present: false };
    store.updateIdentity(T, { accountUuid: 'uuid-A', organizationUuid: 'org-A' }); // the live account under another label
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'sameAccount', email: 'x@x.com' });
    expect(refresh).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('refuses the live record itself as the main one, naming it', async () => {
    expect(await activateAccount(deps(), A)).toEqual({ ok: false, error: 'sameAccount', email: 'a@x.com' });
  });

  it('records the outgoing family as live, also on a record it had to create', async () => {
    store.remove(A);
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    const outgoing = store.list().find((r) => r.id !== T)!;
    expect(outgoing).toMatchObject({ custody: 'app', family: 'live', accountUuid: 'uuid-A' });
  });

  it('removes its backups when the first journal write fails (no live file was touched)', async () => {
    const before = snapshot();
    fs = { ...nodeSwapFs, rename: async (from, to) => { if (to.endsWith('swap-journal.json')) throw Object.assign(new Error('boom'), { code: 'EIO' }); return nodeSwapFs.rename(from, to); } };
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'write' });
    expect(snapshot()).toEqual(before);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('is busy while another swap runs and pending while a journal exists', async () => {
    expect(claimSwap()).toBe(true);
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'busy' });
    releaseSwap();
    put(join(backupDir(), 'swap-journal.json'), { version: 1 });
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'pending' });
  });
});

describe('checkActivationTarget (the makeMain IPC check)', () => {
  it('accepts an app-held target and refuses a missing, set-aside, live, switched-out or cswap-held one, naming it', async () => {
    expect(await checkActivationTarget(deps(), T)).toBeNull();
    expect(await checkActivationTarget(deps(), '123e4567-e89b-42d3-a456-426614174000')).toEqual({ ok: false, error: 'noTarget' });
    expect(await checkActivationTarget(deps(), A)).toEqual({ ok: false, error: 'sameAccount', email: 'a@x.com' });
    store.setCustody(T, 'quarantined', A);
    expect(await checkActivationTarget(deps(), T)).toEqual({ ok: false, error: 'noTarget', email: 'x@x.com' });
    store.setCustody(T, 'foreign');
    expect(await checkActivationTarget(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    store.setCustody(T, 'app');
    store.setFamily(T, 'live');
    roster = { present: true, accounts: [{ email: 'x@x.com' }] };
    expect(await checkActivationTarget(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    expect(await activateAccount(deps(), T)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
  });
});

describe('recoverInterruptedActivation', () => {
  /** The state a crash right after writing the live identity leaves behind. */
  function crashedAfterLiveWrites() {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), 'live-credentials.json'), readFileSync(liveCreds(), 'utf8'));
    writeFileSync(join(backupDir(), 'live-claude.json'), readFileSync(liveJson(), 'utf8'));
    put(join(backupDir(), 'swap-journal.json'), { version: 2, phase: 'live-json-written', outgoingId: A, targetId: T, created: false, outCredsExisted: false, outJsonExisted: false, startedAt: NOW });
    put(join(store.dirOf(A), '.credentials.json'), creds('A'));
    put(liveCreds(), { ...creds('X'), mcpOAuth: { server: 'A' } });
    put(liveJson(), { oauthAccount: account('X', 'x@x.com'), projects: { p: 1 }, numStartups: 4 });
  }

  it('rolls an interrupted swap back when the live login is still exactly what it wrote', async () => {
    const before = readFileSync(liveCreds(), 'utf8');
    crashedAfterLiveWrites();
    expect(await recoverInterruptedActivation(deps())).toBe('recovered');
    expect(readFileSync(liveCreds(), 'utf8')).toBe(before);
    expect(json(liveJson()).oauthAccount).toEqual(account('A', 'a@x.com'));
    expect(existsSync(join(store.dirOf(A), '.credentials.json'))).toBe(false);
    expect(existsSync(backupDir()) ? readdirSync(backupDir()) : []).toEqual([]);
  });

  it('changes nothing when Claude Code renewed the live login since (manual)', async () => {
    crashedAfterLiveWrites();
    put(liveCreds(), { claudeAiOauth: { accessToken: 'fake-acc-new', refreshToken: 'fake-ref-new', expiresAt: FUTURE } });
    const after = snapshot();
    expect(await recoverInterruptedActivation(deps())).toBe('manual');
    expect(snapshot()).toEqual(after);
    expect(existsSync(join(backupDir(), 'swap-journal.json'))).toBe(true);
  });

  it('leaves a 0.9.0 (version 1) journal to the legacy recovery', async () => {
    put(join(backupDir(), 'swap-journal.json'), { version: 1, accountId: T, phase: 'backed-up' });
    expect(await recoverInterruptedActivation(deps())).toBe('legacy');
  });

  it('deletes backups a crash left before the first journal, then defers to the legacy recovery', async () => {
    mkdirSync(backupDir(), { recursive: true });
    writeFileSync(join(backupDir(), 'live-credentials.json'), readFileSync(liveCreds(), 'utf8'));
    writeFileSync(join(backupDir(), 'outgoing-claude.json'), '{}');
    writeFileSync(join(backupDir(), 'live-claude.json.123e4567-e89b-42d3-a456-426614174000.tmp'), '{}');
    writeFileSync(join(backupDir(), 'main-credentials.json'), '{}'); // a 0.9.0 backup is the legacy recovery's business
    expect(await recoverInterruptedActivation(deps())).toBe('legacy');
    expect(readdirSync(backupDir())).toEqual(['main-credentials.json']);
  });

  it('finishes the roles of a verified swap', async () => {
    put(join(backupDir(), 'swap-journal.json'), { version: 2, phase: 'verified', outgoingId: A, targetId: T, created: false, outCredsExisted: false, outJsonExisted: false, startedAt: NOW });
    expect(await recoverInterruptedActivation(deps())).toBe('none');
    expect(store.get(T)?.custody).toBe('live');
    expect(store.get(A)?.custody).toBe('app');
  });
});

describe('an external switch after an app swap (investigation test 12)', () => {
  it('cswap writes its own copy of A into Claude Code: one card per account, the target is never POSTed', async () => {
    expect((await activateAccount(deps(), T)).ok).toBe(true);
    // cswap's switch: a different token family of A plus A's identity.
    put(liveCreds(), { claudeAiOauth: { accessToken: 'fake-acc-cswap', refreshToken: 'fake-ref-cswap', expiresAt: FUTURE } });
    put(liveJson(), { oauthAccount: account('A', 'a@x.com') });
    await reconcileLive({ store, readLiveIdentity: async () => ({ email: 'a@x.com', accountUuid: 'uuid-A', organizationUuid: 'org-A' }), now: () => NOW });
    expect(store.get(A)?.custody).toBe('live');
    expect(store.get(T)?.custody).toBe('foreign');
    const refs = claudeRefs({ records: store.list(), dirOf: (id) => store.dirOf(id), live: store.live(), cswap: roster, platform: 'win32' });
    expect(refs.map((r) => r.id)).toEqual([`claude:${A}`, `claude:${T}`]);
    put(join(store.dirOf(T), '.credentials.json'), creds('X', NOW - 1000));
    const refreshClaude = vi.fn();
    const fetchDeps: FetcherDeps = {
      credentials: { env: {}, home, platform: 'win32', keychain: async () => null, readFile: (p) => Promise.resolve(existsSync(p) ? readFileSync(p, 'utf8') : null) },
      fetch: vi.fn() as never, now: () => NOW, sleep: async () => undefined, codexHome: () => join(home, '.codex'),
      claudeUrl: 'https://claude.test/usage', codexUrl: 'https://codex.test/usage', refreshClaude,
    };
    const { usage } = await fetchClaude(fetchDeps, refs[1]);
    expect(usage.status).toBe('elsewhere');
    expect(refreshClaude).not.toHaveBeenCalled();
  });
});
