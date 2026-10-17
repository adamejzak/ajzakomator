import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsStore } from '../src/main/accounts/store';
import { isSwapRunning, nodeSwapFs, swapMainAccount, type SwapDeps, type SwapFs } from '../src/main/accounts/swap';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const FUTURE = NOW + 3_600_000;
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let root: string;
let home: string;
let store: AccountsStore;
let fs: SwapFs;
let refresh: SwapDeps['refresh'];
let env: NodeJS.ProcessEnv;
let platform: NodeJS.Platform;

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const put = (path: string, data: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
const mainCreds = () => join(home, '.claude', '.credentials.json');
const mainJson = () => join(home, '.claude.json');
const tDir = (id = ID) => store.dirOf(id);
const journalPath = () => join(root, 'accounts', 'swap-backup', 'swap-journal.json');
const creds = (n: string, expiresAt = FUTURE) => ({ claudeAiOauth: { accessToken: `tok-${n}`, refreshToken: `ref-${n}`, expiresAt, scopes: ['s'], subscriptionType: 'max' }, mcpOAuth: { server: n } });
const account = (n: string, email: string) => ({ emailAddress: email, organizationName: `Org ${n}`, accountUuid: `uuid-${n}`, displayName: n });
const deps = (): SwapDeps => ({ home, env, platform, store, backupDir: join(root, 'accounts', 'swap-backup'), now: () => NOW, refresh, delay: async () => undefined, fs });
const allFiles = () => [mainCreds(), mainJson(), join(tDir(), '.credentials.json'), join(tDir(), '.claude.json')];
const snapshot = () => allFiles().map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
const parsed = (list: (string | null)[]) => list.map((t) => (t === null ? null : JSON.parse(t)));
const temps = () => [join(home, '.claude'), home, tDir(), join(root, 'accounts', 'swap-backup')].flatMap((d) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.tmp')) : []));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ajza-swap-'));
  home = join(root, 'home');
  store = new AccountsStore(join(root, 'accounts'));
  fs = nodeSwapFs;
  refresh = async () => ({ kind: 'ok' });
  env = {};
  platform = 'win32';
  put(mainCreds(), creds('A'));
  put(mainJson(), { oauthAccount: account('A', 'a@x.com'), projects: { p: 1 }, numStartups: 4 });
  store.commit({ id: ID, email: 'x@x.com', org: 'Org X', addedAt: 1 });
  put(join(tDir(), '.credentials.json'), creds('X'));
  put(join(tDir(), '.claude.json'), { oauthAccount: account('X', 'x@x.com'), theme: 'dark' });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

const failRenameTo = (dest: string, times = Infinity, code = 'EIO'): SwapFs => {
  let left = times;
  return { ...nodeSwapFs, rename: async (from, to) => { if (to === dest && left-- > 0) throw Object.assign(new Error('boom'), { code }); return nodeSwapFs.rename(from, to); } };
};

describe('swapMainAccount', () => {
  it('exchanges the logins and keeps unrelated keys', async () => {
    const log = vi.spyOn(console, 'log'); const err = vi.spyOn(console, 'error');
    const result = await swapMainAccount(deps(), ID);
    expect(result).toEqual({ ok: true, email: 'x@x.com' });
    expect(json(mainCreds())).toEqual({ ...creds('X'), mcpOAuth: { server: 'A' } });
    expect(json(mainJson())).toEqual({ oauthAccount: account('X', 'x@x.com'), projects: { p: 1 }, numStartups: 4 });
    expect(json(join(tDir(), '.credentials.json'))).toEqual({ claudeAiOauth: creds('A').claudeAiOauth, mcpOAuth: { server: 'X' } });
    expect(json(join(tDir(), '.claude.json'))).toEqual({ oauthAccount: account('A', 'a@x.com'), theme: 'dark' });
    expect(store.list()[0]).toMatchObject({ id: ID, email: 'a@x.com', org: 'Org A' });
    expect(existsSync(journalPath())).toBe(false);
    // live tokens must not linger after a verified swap
    expect(existsSync(join(root, 'accounts', 'swap-backup')) ? readdirSync(join(root, 'accounts', 'swap-backup')) : []).toEqual([]);
    expect(temps()).toEqual([]);
    expect(JSON.stringify([result, log.mock.calls, err.mock.calls])).not.toContain('tok-');
    expect(isSwapRunning()).toBe(false);
  });

  it('swapping twice restores the original state', async () => {
    const before = snapshot();
    await swapMainAccount(deps(), ID);
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: true, email: 'a@x.com' });
    expect(parsed(snapshot())).toEqual(parsed(before));
    expect(store.list()[0]).toMatchObject({ email: 'x@x.com', org: 'Org X' });
  });

  it('derives the identity from the account entry when the profile has no claude.json', async () => {
    rmSync(join(tDir(), '.claude.json'));
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: true, email: 'x@x.com' });
    expect(json(mainJson()).oauthAccount).toEqual({ emailAddress: 'x@x.com', organizationName: 'Org X' });
  });

  it('honours CLAUDE_CONFIG_DIR', async () => {
    const custom = join(root, 'custom');
    put(join(custom, '.credentials.json'), creds('A')); put(join(custom, '.claude.json'), { oauthAccount: account('A', 'a@x.com') });
    rmSync(join(home, '.claude'), { recursive: true }); rmSync(mainJson());
    env = { CLAUDE_CONFIG_DIR: custom };
    expect((await swapMainAccount(deps(), ID)).ok).toBe(true);
    expect(json(join(custom, '.credentials.json')).claudeAiOauth.accessToken).toBe('tok-X');
    expect(json(join(custom, '.claude.json')).oauthAccount.emailAddress).toBe('x@x.com');
  });

  describe('refusals', () => {
    const untouched = async (error: string, id = ID) => {
      const before = snapshot();
      expect(await swapMainAccount(deps(), id)).toEqual({ ok: false, error });
      expect(snapshot()).toEqual(before);
      expect(temps()).toEqual([]);
    };
    it('unsupported platform', async () => { platform = 'darwin'; await untouched('unsupported'); });
    it('invalid id', async () => { await untouched('invalid', '../x'); });
    it('env token', async () => { env = { CLAUDE_CODE_OAUTH_TOKEN: ' t ' }; await untouched('envToken'); });
    it('no main credentials', async () => { rmSync(mainCreds()); expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'noMain' }); });
    it('main without refresh token', async () => { put(mainCreds(), { claudeAiOauth: { accessToken: 'tok-A' } }); await untouched('noMain'); });
    it('main without identity', async () => { put(mainJson(), {}); await untouched('noMain'); });
    it('unknown or broken target', async () => { await untouched('noTarget', OTHER); writeFileSync(join(tDir(), '.credentials.json'), '{'); await untouched('noTarget'); });
    it('same account', async () => { put(join(tDir(), '.claude.json'), { oauthAccount: account('A', 'a@x.com') }); await untouched('sameAccount'); });
    it('same account by e-mail without uuid', async () => { put(mainJson(), { oauthAccount: { emailAddress: 'X@x.com', organizationName: 'org x' } }); await untouched('sameAccount'); });
    it('duplicate of the main login among other accounts', async () => {
      store.commit({ id: OTHER, email: 'A@X.com', org: 'Org A', addedAt: 2 });
      put(join(tDir(OTHER), '.credentials.json'), creds('B'));
      await untouched('duplicate');
    });
    it('dead login', async () => { refresh = async () => ({ kind: 'dead' }); await untouched('dead'); });
    it('transient with an expired token', async () => {
      put(join(tDir(), '.credentials.json'), creds('X', NOW + 30_000));
      refresh = async () => ({ kind: 'transient' });
      await untouched('transient');
    });
    it('refresh that throws counts as transient', async () => {
      put(join(tDir(), '.credentials.json'), creds('X', 1));
      refresh = async () => { throw new Error('net'); };
      await untouched('transient');
    });
  });

  it('continues on a transient refresh while the token is still valid', async () => {
    refresh = async () => ({ kind: 'transient' });
    expect((await swapMainAccount(deps(), ID)).ok).toBe(true);
  });

  it('is busy while another swap runs', async () => {
    let release!: () => void;
    refresh = () => new Promise((resolve) => { release = () => resolve({ kind: 'ok' }); });
    const first = swapMainAccount(deps(), ID);
    expect(isSwapRunning()).toBe(true);
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'busy' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect((await first).ok).toBe(true);
  });

  describe('write failures roll everything back', () => {
    const steps: [string, () => string][] = [
      ['target credentials', () => join(tDir(), '.credentials.json')],
      ['target claude.json', () => join(tDir(), '.claude.json')],
      ['main credentials', () => mainCreds()],
      ['main claude.json', () => mainJson()],
    ];
    for (const [name, path] of steps) {
      it(`fails at ${name}`, async () => {
        const before = snapshot();
        const storeBefore = store.list();
        fs = failRenameTo(path());
        expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'write' });
        expect(snapshot()).toEqual(before);
        expect(store.list()).toEqual(storeBefore);
        expect(temps()).toEqual([]);
        expect(existsSync(journalPath())).toBe(false);
      });
    }

    it('removes a target claude.json that did not exist', async () => {
      rmSync(join(tDir(), '.claude.json'));
      fs = failRenameTo(mainJson());
      expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'write' });
      expect(existsSync(join(tDir(), '.claude.json'))).toBe(false);
    });

    it('retries EPERM renames and succeeds', async () => {
      fs = failRenameTo(mainCreds(), 3, 'EPERM');
      expect((await swapMainAccount(deps(), ID)).ok).toBe(true);
    });

    it('gives up after too many EBUSY failures', async () => {
      const before = snapshot();
      fs = failRenameTo(mainCreds(), 6, 'EBUSY');
      expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'write' });
      expect(snapshot()).toEqual(before);
    });

    it('fails before changing anything when the backup cannot be written', async () => {
      const before = snapshot();
      fs = { ...nodeSwapFs, mkdir: async () => { throw new Error('no'); } };
      expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'write' });
      expect(snapshot()).toEqual(before);
    });
  });

  describe('shared files changed by Claude Code mid-swap', () => {
    const onFirstRenameTo = (dest: string, act: () => void): SwapFs => {
      let done = false;
      return { ...nodeSwapFs, rename: async (from, to) => { if (to === dest && !done) { done = true; act(); } return nodeSwapFs.rename(from, to); } };
    };

    it('redoes the whole pass when the credentials were refreshed', async () => {
      fs = onFirstRenameTo(join(tDir(), '.credentials.json'), () => put(mainCreds(), creds('A2')));
      expect((await swapMainAccount(deps(), ID)).ok).toBe(true);
      expect(json(join(tDir(), '.credentials.json')).claudeAiOauth.accessToken).toBe('tok-A2');
      expect(json(mainCreds()).claudeAiOauth.accessToken).toBe('tok-X');
      expect(temps()).toEqual([]);
    });

    it('recomputes claude.json from the fresh content', async () => {
      fs = onFirstRenameTo(mainCreds(), () => put(mainJson(), { oauthAccount: account('A', 'a@x.com'), projects: { p: 1 }, added: 'new-field' }));
      expect((await swapMainAccount(deps(), ID)).ok).toBe(true);
      expect(json(mainJson())).toMatchObject({ added: 'new-field', oauthAccount: { emailAddress: 'x@x.com' } });
    });

    it('gives up with write and rolls back when the file keeps changing', async () => {
      const before = snapshot();
      let n = 0;
      fs = { ...nodeSwapFs, stat: async (p) => { const s = await nodeSwapFs.stat(p); return p === mainJson() && s ? { ...s, size: s.size + n++ } : s; } };
      expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'write' });
      expect(snapshot()).toEqual(before);
      expect(temps()).toEqual([]);
    });
  });
});
