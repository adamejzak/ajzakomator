import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountsStore } from '../src/main/accounts/store';
import { nodeSwapFs, recoverInterruptedSwap, swapMainAccount, type SwapDeps, type SwapFs } from '../src/main/accounts/swap';

const FUTURE = Date.parse('2026-10-11T12:00:00Z') + 3_600_000;
const ID = '11111111-1111-4111-8111-111111111111';

let root: string;
let home: string;
let store: AccountsStore;
let fs: SwapFs;
let env: NodeJS.ProcessEnv;

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const put = (path: string, data: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
const mainCreds = () => join(home, '.claude', '.credentials.json');
const mainJson = () => join(home, '.claude.json');
const tDir = () => store.dirOf(ID);
const tCreds = () => join(tDir(), '.credentials.json');
const tJson = () => join(tDir(), '.claude.json');
const backup = () => join(root, 'accounts', 'swap-backup');
const journalPath = () => join(backup(), 'swap-journal.json');
const creds = (n: string) => ({ claudeAiOauth: { accessToken: `tok-${n}`, refreshToken: `ref-${n}`, expiresAt: FUTURE, scopes: ['s'] }, mcpOAuth: { server: n } });
const account = (n: string, email: string) => ({ emailAddress: email, organizationName: `Org ${n}`, accountUuid: `uuid-${n}`, displayName: n });
const deps = (): SwapDeps => ({ home, env, platform: 'win32', store, backupDir: backup(), now: () => Date.parse('2026-10-11T12:00:00Z'), refresh: async () => ({ kind: 'ok' }), delay: async () => undefined, fs });
const snapshot = () => [mainCreds(), mainJson(), tCreds(), tJson()].map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
const backupFiles = () => (existsSync(backup()) ? readdirSync(backup()).sort() : []);
const token = (path: string) => json(path).claudeAiOauth.accessToken;
const acct = (path: string) => json(path).oauthAccount.emailAddress;

/** Lets a swap finish but keeps its backup and journal, like a process that died before cleaning up. */
const keepBackups: SwapFs = { ...nodeSwapFs, rm: async (p) => { if (!p.includes('swap-backup')) await nodeSwapFs.rm(p); } };
async function crashed(phase: string): Promise<void> {
  fs = keepBackups;
  await swapMainAccount(deps(), ID);
  fs = nodeSwapFs;
  writeFileSync(journalPath(), JSON.stringify({ version: 1, accountId: ID, startedAt: 1, phase, targetJsonExisted: true }));
}
const original = () => {
  put(mainCreds(), creds('A')); put(mainJson(), { oauthAccount: account('A', 'a@x.com'), projects: { p: 1 } });
  put(tCreds(), creds('X')); put(tJson(), { oauthAccount: account('X', 'x@x.com'), theme: 'dark' });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ajza-swap-rec-'));
  home = join(root, 'home');
  store = new AccountsStore(join(root, 'accounts'));
  fs = nodeSwapFs;
  env = {};
  store.commit({ id: ID, email: 'x@x.com', org: 'Org X', addedAt: 1 });
  original();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('recoverInterruptedSwap', () => {
  it('does nothing without a journal', async () => {
    expect(await recoverInterruptedSwap(deps())).toBe('none');
  });

  it('keeps both logins when Claude Code rotated main after a swap that died late (ambiguous)', async () => {
    await crashed('main-json-written');
    // After the swap main holds X and the target profile holds A; Claude Code then rotated main's token.
    put(mainCreds(), creds('X2'));
    const before = snapshot();
    const files = backupFiles();
    expect(await recoverInterruptedSwap(deps())).toBe('manual');
    expect(snapshot()).toEqual(before);
    expect(token(tCreds())).toBe('tok-A');
    expect(token(mainCreds())).toBe('tok-X2');
    expect(backupFiles()).toEqual(files);
    expect(existsSync(journalPath())).toBe(true);
  });

  it('modifies nothing when neither file can be attributed', async () => {
    await crashed('main-creds-written');
    put(mainCreds(), creds('M9')); put(tCreds(), creds('T9'));
    const before = snapshot();
    expect(await recoverInterruptedSwap(deps())).toBe('manual');
    expect(snapshot()).toEqual(before);
    expect(existsSync(journalPath())).toBe(true);
  });

  it('never counts an empty credentials file as ours', async () => {
    await crashed('main-creds-written');
    put(mainCreds(), {});
    const before = snapshot();
    expect(await recoverInterruptedSwap(deps())).toBe('manual');
    expect(snapshot()).toEqual(before);
  });

  it('rolls back when the credentials are in their original positions', async () => {
    await crashed('target-written');
    original();
    put(tJson(), { oauthAccount: account('A', 'a@x.com'), theme: 'dark' }); // target identity was already written
    expect(await recoverInterruptedSwap(deps())).toBe('recovered');
    expect(token(mainCreds())).toBe('tok-A');
    expect(token(tCreds())).toBe('tok-X');
    expect(acct(tJson())).toBe('x@x.com');
    expect(json(tJson()).theme).toBe('dark');
    expect(backupFiles()).toEqual([]);
  });

  it('restores the target login when only its copy of main was written', async () => {
    await crashed('main-creds-written');
    original();
    put(tCreds(), creds('A')); // target holds a copy of main's blob, main untouched
    expect(await recoverInterruptedSwap(deps())).toBe('recovered');
    expect(token(mainCreds())).toBe('tok-A');
    expect(token(tCreds())).toBe('tok-X');
    expect(json(tCreds()).mcpOAuth).toEqual({ server: 'A' }); // only the oauth key was written
    expect(backupFiles()).toEqual([]);
  });

  it('completes an exchange whose identity half is missing', async () => {
    await crashed('main-json-written');
    put(mainJson(), { oauthAccount: account('A', 'a@x.com'), projects: { p: 2 } });
    put(tJson(), { oauthAccount: account('X', 'x@x.com'), theme: 'dark' });
    expect(await recoverInterruptedSwap(deps())).toBe('recovered');
    expect(token(mainCreds())).toBe('tok-X');
    expect(token(tCreds())).toBe('tok-A');
    expect(acct(mainJson())).toBe('x@x.com');
    expect(json(mainJson()).projects).toEqual({ p: 2 });
    expect(acct(tJson())).toBe('a@x.com');
    expect(store.list()[0].email).toBe('a@x.com');
    expect(backupFiles()).toEqual([]);
  });

  it('only removes the backup after a verified swap', async () => {
    await crashed('verified');
    const before = snapshot();
    expect(await recoverInterruptedSwap(deps())).toBe('none');
    expect(snapshot()).toEqual(before);
    expect(backupFiles()).toEqual([]);
  });

  it('reports a corrupt journal and keeps everything', async () => {
    mkdirSync(backup(), { recursive: true });
    writeFileSync(journalPath(), 'nope');
    expect(await recoverInterruptedSwap(deps())).toBe('manual');
    expect(existsSync(journalPath())).toBe(true);
  });
});

describe('rollback follows the position of a token', () => {
  const renameHook = (hook: (to: string, n: number) => void): SwapFs => {
    const seen = new Map<string, number>();
    return { ...nodeSwapFs, rename: async (from, to) => { const n = (seen.get(to) ?? 0) + 1; seen.set(to, n); hook(to, n); return nodeSwapFs.rename(from, to); } };
  };
  const boom = () => Object.assign(new Error('boom'), { code: 'EIO' });

  it('sends a token that Claude Code rotated after step 2 back to the target profile', async () => {
    fs = renameHook((to) => { if (to === mainJson()) { put(mainCreds(), creds('X2')); throw boom(); } });
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'write' });
    expect(token(mainCreds())).toBe('tok-A');
    expect(token(tCreds())).toBe('tok-X2');
    expect(acct(mainJson())).toBe('a@x.com');
    expect(acct(tJson())).toBe('x@x.com');
    expect(backupFiles()).toEqual([]);
  });

  it('stops after an unclean rollback: no retry, backup and journal kept, nothing lost', async () => {
    const calls: number[] = [];
    fs = renameHook((to, n) => {
      if (to === tCreds()) { calls.push(n); if (n === 1) put(mainCreds(), creds('A2')); if (n === 3) throw boom(); }
      if (to === mainJson()) throw boom();
    });
    // n=1: forward write (main refreshed meanwhile, guard trips), n=2: forward again, n=3: the rollback write fails.
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'manual' });
    expect(calls).toEqual([1, 2, 3]);
    expect(token(mainCreds())).toBe('tok-X');
    expect(token(tCreds())).toBe('tok-A2');
    expect(existsSync(journalPath())).toBe(true);
    expect(json(journalPath()).phase).toBe('rolling-back');
    expect(backupFiles()).toContain('main-credentials.json');
    expect(JSON.stringify(readFileSync(journalPath(), 'utf8'))).not.toContain('tok-');
  });

  it('re-checks the shared file before every rename retry', async () => {
    fs = renameHook((to, n) => {
      if (to === mainCreds() && n === 1) { put(mainCreds(), creds('A2')); throw Object.assign(new Error('busy'), { code: 'EPERM' }); }
    });
    expect((await swapMainAccount(deps(), ID)).ok).toBe(true);
    expect(token(tCreds())).toBe('tok-A2');
    expect(token(mainCreds())).toBe('tok-X');
  });

  it('removes the backup after a clean failure', async () => {
    fs = renameHook((to) => { if (to === mainJson()) throw boom(); });
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'write' });
    expect(backupFiles()).toEqual([]);
    expect(token(mainCreds())).toBe('tok-A');
    expect(token(tCreds())).toBe('tok-X');
  });
});

describe('identity and path rules', () => {
  it('refuses a relative CLAUDE_CONFIG_DIR', async () => {
    env = { CLAUDE_CONFIG_DIR: 'relative/dir' };
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'noMain' });
  });

  it('treats an unknown organisation as the same account', async () => {
    put(mainJson(), { oauthAccount: { emailAddress: 'x@x.com' } });
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'sameAccount' });
  });

  it('completes a target account object that has no e-mail from the stored entry', async () => {
    put(tJson(), { oauthAccount: { accountUuid: 'uuid-X' } });
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: true, email: 'x@x.com' });
    expect(acct(mainJson())).toBe('x@x.com');
  });
});
