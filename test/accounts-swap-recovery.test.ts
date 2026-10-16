import type { RefreshOutcome } from '../src/main/accounts/refresh';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountMutationBlock, dismissAccountNotice, gateProfileRefresh, handleRemoveAccount, loginBlock } from '../src/main/accounts/guards';
import { AccountsReadOnlyError, AccountsStore } from '../src/main/accounts/store';
import { clearPendingSwap, hasPendingSwap, isSwapUnresolved, nodeSwapFs, recoverInterruptedSwap, swapMainAccount, type SwapDeps, type SwapFs } from '../src/main/accounts/swap';

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

  it('does not guess when Claude Code rotated main after our write and a later step fails', async () => {
    fs = renameHook((to) => { if (to === mainJson()) { put(mainCreds(), creds('X2')); throw boom(); } });
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'manual' });
    // main keeps what Claude Code wrote, the target keeps the old main login; the X1 login stays recoverable from the backup
    expect(token(mainCreds())).toBe('tok-X2');
    expect(token(tCreds())).toBe('tok-A');
    expect(json(join(backup(), 'target-credentials.json')).claudeAiOauth.accessToken).toBe('tok-X');
    expect(existsSync(journalPath())).toBe(true);
  });

  it('S2: a refresh result written into main right after our write makes the outcome manual', async () => {
    let first = true;
    const d = { ...deps(), delay: async () => { if (first) { first = false; put(mainCreds(), creds('A2')); } } };
    expect(await swapMainAccount(d, ID)).toEqual({ ok: false, error: 'manual' });
    expect(token(mainCreds())).toBe('tok-A2');
    expect(token(tCreds())).toBe('tok-A');
    expect(json(join(backup(), 'target-credentials.json')).claudeAiOauth.accessToken).toBe('tok-X');
    expect(json(join(backup(), 'main-credentials.json')).claudeAiOauth.accessToken).toBe('tok-A');
    expect(existsSync(journalPath())).toBe(true);
  });

  it('S2b: the same after the main identity was written', async () => {
    let calls = 0;
    const d = { ...deps(), delay: async () => { if (++calls === 2) put(mainCreds(), creds('X2')); } };
    expect(await swapMainAccount(d, ID)).toEqual({ ok: false, error: 'manual' });
    expect(token(mainCreds())).toBe('tok-X2');
    expect(existsSync(journalPath())).toBe(true);
    expect(backupFiles()).toContain('target-credentials.json');
  });

  it('blocks a second swap while an unresolved one left its journal and backups', async () => {
    fs = renameHook((to, n) => {
      if (to === mainJson()) throw boom();
      if (to === mainCreds() && n >= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'manual' });
    fs = nodeSwapFs;
    const before = snapshot();
    const files = backupFiles().map((n) => [n, readFileSync(join(backup(), n), 'utf8')]);
    // T1: the old main login is still live in the target profile, the target login only in main (never duplicated)
    expect(token(mainCreds())).toBe('tok-X');
    expect(token(tCreds())).toBe('tok-A');
    expect(json(join(backup(), 'main-credentials.json')).claudeAiOauth.accessToken).toBe('tok-A');
    expect(json(join(backup(), 'target-credentials.json')).claudeAiOauth.accessToken).toBe('tok-X');
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'pending' });
    expect(snapshot()).toEqual(before);
    expect(backupFiles().map((n) => [n, readFileSync(join(backup(), n), 'utf8')])).toEqual(files);
    expect(await hasPendingSwap(deps())).toBe(true);
    // the user clears it deliberately
    expect(await clearPendingSwap(deps())).toBe(true);
    expect(existsSync(backup())).toBe(false);
    expect(await hasPendingSwap(deps())).toBe(false);
  });

  it('stops after an unclean rollback: no retry, backup and journal kept, nothing lost', async () => {
    const calls: number[] = [];
    fs = renameHook((to, n) => {
      if (to === tCreds()) { calls.push(n); if (n === 1) put(mainCreds(), creds('A2')); if (n === 3) throw boom(); }
      if (to === mainJson()) throw boom();
    });
    // n=1: forward write (main refreshed meanwhile, guard trips), n=2: forward again, n=3: the rollback write fails.
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'manual' });
    // the displaced blob (A, rotated to A2) is written back into the target at once (n=4); X is never duplicated
    expect(calls).toEqual([1, 2, 3, 4]);
    expect(token(mainCreds())).toBe('tok-X');
    expect(token(tCreds())).toBe('tok-A2');
    expect(json(join(backup(), 'main-credentials.json')).claudeAiOauth.accessToken).toBe('tok-A2');
    expect(json(join(backup(), 'target-credentials.json')).claudeAiOauth.accessToken).toBe('tok-X');
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

describe('startup cleanup', () => {
  it('deletes stray backups when there is no journal, and only our own stale temp files', async () => {
    mkdirSync(backup(), { recursive: true });
    writeFileSync(join(backup(), 'main-credentials.json'), JSON.stringify(creds('A')));
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const stale = [join(home, '.claude', `.credentials.json.${uuid}.tmp`), join(home, `.claude.json.${uuid}.tmp`), join(tDir(), `.credentials.json.${uuid}.tmp`)];
    const keep = [join(home, '.claude', 'notes.tmp'), join(home, '.claude', '.credentials.json.backup.tmp')];
    for (const f of [...stale, ...keep]) writeFileSync(f, 'x');
    const before = snapshot();
    expect(await recoverInterruptedSwap(deps())).toBe('none');
    expect(existsSync(backup())).toBe(false);
    for (const f of stale) expect(existsSync(f)).toBe(false);
    for (const f of keep) expect(existsSync(f)).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it('keeps temp files while an unresolved journal exists', async () => {
    await crashed('main-creds-written');
    put(mainCreds(), creds('M9')); put(tCreds(), creds('T9'));
    const stale = join(home, '.claude', '.credentials.json.123e4567-e89b-42d3-a456-426614174000.tmp');
    writeFileSync(stale, 'x');
    expect(await recoverInterruptedSwap(deps())).toBe('manual');
    expect(existsSync(stale)).toBe(true);
  });
});

describe('account mutation guards', () => {
  const base = (running: boolean, pending: boolean) => ({ swapRunning: () => running, swapPending: async () => pending });
  const removeDeps = (running: boolean, pending: boolean) => {
    const calls: string[] = [];
    return { calls, deps: { ...base(running, pending), isLive: () => false, cancelLogin: () => calls.push('cancel'), remove: () => calls.push('remove'), onRemoved: () => calls.push('refresh') } };
  };

  it('refuses to remove an account while a swap runs or is pending', async () => {
    for (const [running, pending, error] of [[true, false, 'busy'], [false, true, 'pending']] as const) {
      const { calls, deps: d } = removeDeps(running, pending);
      expect(await handleRemoveAccount(d, ID)).toEqual({ ok: false, error });
      expect(calls).toEqual([]);
    }
  });

  it('removes when nothing blocks and validates the id', async () => {
    const { calls, deps: d } = removeDeps(false, false);
    expect(await handleRemoveAccount(d, '../x')).toEqual({ ok: false });
    expect(await handleRemoveAccount(d, ID)).toEqual({ ok: true });
    expect(calls).toEqual(['cancel', 'remove', 'refresh']);
  });

  it('answers a fixed readOnly code instead of throwing when accounts.json cannot be read safely', async () => {
    const { calls, deps: d } = removeDeps(false, false);
    expect(await handleRemoveAccount({ ...d, readOnly: () => true }, ID)).toEqual({ ok: false, error: 'readOnly' });
    expect(calls).toEqual([]);
    // The file became unreadable between the check and the write: the store's refusal is the same code.
    const thrown = { ...d, remove: () => { throw new AccountsReadOnlyError(); } };
    expect(await handleRemoveAccount(thrown, ID)).toEqual({ ok: false, error: 'readOnly' });
    await expect(handleRemoveAccount({ ...d, remove: () => { throw new Error('io'); } }, ID)).rejects.toThrow('io');
  });

  it('refuses to remove the live record with the fixed code live, also when it became live while waiting (M2)', async () => {
    const { calls, deps: d } = removeDeps(false, false);
    expect(await handleRemoveAccount({ ...d, isLive: (id: string) => id === ID }, ID)).toEqual({ ok: false, error: 'live' });
    let live = false;
    const racing = { ...d, isLive: () => live, swapPending: async () => { live = true; return false; } };
    expect(await handleRemoveAccount(racing, ID)).toEqual({ ok: false, error: 'live' });
    expect(calls).toEqual([]);
  });

  it('checks read-only again after waiting for the swap state, before a parked restore is dropped', async () => {
    const { calls, deps: d } = removeDeps(false, false);
    let readOnly = false;
    const racing = { ...d, readOnly: () => readOnly, swapPending: async () => { readOnly = true; return false; } };
    expect(await handleRemoveAccount(racing, ID)).toEqual({ ok: false, error: 'readOnly' });
    expect(calls).toEqual([]);
  });

  it('dismissing a notice ignores only a read-only store and turns other failures into a fixed error', () => {
    const ids: string[] = [];
    dismissAccountNotice({ dismissNotice: (id) => { ids.push(id); } }, 'n1');
    dismissAccountNotice({ dismissNotice: (id) => { ids.push(id); } }, 5);
    dismissAccountNotice({ dismissNotice: (id) => { ids.push(id); } }, 'x'.repeat(65));
    expect(ids).toEqual(['n1']);
    expect(() => dismissAccountNotice({ dismissNotice: () => { throw new AccountsReadOnlyError(); } }, 'n1')).not.toThrow();
    expect(() => dismissAccountNotice({ dismissNotice: () => { throw new Error('EACCES C:/secret/path'); } }, 'n1')).toThrow(/^notice not dismissed$/);
  });

  it('refuses every Claude login while accounts.json is read-only (it could not be saved), never a Codex one', async () => {
    const ro = { ...base(false, false), readOnly: () => true };
    for (const type of ['new', 'main', 'account'] as const) {
      expect(await loginBlock(ro, { provider: 'claude', target: type === 'account' ? { type, id: ID } : { type } })).toBe('readOnly');
    }
    expect(await loginBlock(ro, { provider: 'codex', target: { type: 'main' } })).toBeNull();
  });

  it('holds re-logins of the main login or a saved account, not new accounts', async () => {
    expect(await loginBlock(base(false, true), { provider: 'claude', target: { type: 'main' } })).toBe('pending');
    expect(await loginBlock(base(true, false), { provider: 'claude', target: { type: 'account', id: ID } })).toBe('busy');
    expect(await loginBlock(base(false, true), { provider: 'claude', target: { type: 'new' } })).toBeNull();
    expect(await accountMutationBlock({ swapRunning: () => false, swapPending: async () => { throw new Error('io'); } })).toBe('pending');
  });
});

describe('identical tokens after a crash', () => {
  it('forward: A2 in main and target, the target gets its own login back from the backup', async () => {
    await crashed('main-creds-written');
    put(mainCreds(), creds('A2')); put(tCreds(), creds('A2'));
    expect(await recoverInterruptedSwap(deps())).toBe('recovered');
    expect(token(mainCreds())).toBe('tok-A2');
    expect(token(tCreds())).toBe('tok-X');
    expect(acct(mainJson())).toBe('a@x.com');
    expect(acct(tJson())).toBe('x@x.com');
    expect(backupFiles()).toEqual([]);
  });

  it('reverse: X in both, the old main login returns to the target from the backup', async () => {
    await crashed('rolling-back');
    put(tCreds(), creds('X'));
    expect(await recoverInterruptedSwap(deps())).toBe('recovered');
    expect(token(mainCreds())).toBe('tok-X');
    expect(token(tCreds())).toBe('tok-A');
    expect(acct(mainJson())).toBe('x@x.com');
    expect(acct(tJson())).toBe('a@x.com');
  });
});

describe('cleanup order and guards', () => {
  it('deletes the journal before the backup files', async () => {
    const order: string[] = [];
    fs = { ...nodeSwapFs, rm: async (p) => { if (p.includes('swap-backup')) order.push(basename(p)); return nodeSwapFs.rm(p); } };
    expect((await swapMainAccount(deps(), ID)).ok).toBe(true);
    expect(order[0]).toBe('swap-journal.json');
  });

  it('keeps managed profiles untouched by background refreshes while a swap runs or is pending', async () => {
    let calls = 0;
    const refresh = async (): Promise<RefreshOutcome> => { calls++; return { kind: 'ok' }; };
    const blocked: RefreshOutcome = { kind: 'transient' };
    expect(await gateProfileRefresh({ swapRunning: () => true, swapPending: async () => false }, refresh, blocked)('d')).toEqual(blocked);
    expect(await gateProfileRefresh({ swapRunning: () => false, swapPending: async () => true, swapPendingNow: () => true }, refresh, blocked)('d')).toEqual(blocked);
    expect(calls).toBe(0);
    expect(await gateProfileRefresh({ swapRunning: () => false, swapPending: async () => false }, refresh, blocked)('d')).toEqual({ kind: 'ok' });
    expect(calls).toBe(1);
  });

  it('does not block Codex logins', async () => {
    expect(await loginBlock({ swapRunning: () => true, swapPending: async () => true }, { provider: 'codex', target: { type: 'main' } })).toBeNull();
  });
});

describe('stale writes and recovery', () => {
  it('a stale A blob written into main after the settle read leaves a manual state that recovery does not touch', async () => {
    let armed = false;
    let reads = 0;
    fs = {
      ...nodeSwapFs,
      rename: async (from, to) => { await nodeSwapFs.rename(from, to); if (to === mainJson()) armed = true; },
      readFile: async (p) => {
        const text = await nodeSwapFs.readFile(p);
        if (armed && p === mainCreds() && ++reads === 1) put(mainCreds(), creds('A')); // Claude Code writes its unrotated A blob
        return text;
      },
    };
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'manual' });
    fs = nodeSwapFs;
    expect(acct(tJson())).toBe('a@x.com'); // the profile holding A is not relabelled X
    const before = snapshot();
    expect(await recoverInterruptedSwap(deps())).toBe('manual');
    expect(snapshot()).toEqual(before);
    expect(json(join(backup(), 'target-credentials.json')).claudeAiOauth.accessToken).toBe('tok-X');
    expect(json(journalPath()).phase).toBe('rolling-back');
    expect(backupFiles()).toEqual(expect.arrayContaining(['main-credentials.json', 'target-credentials.json', 'swap-journal.json']));
    expect(isSwapUnresolved()).toBe(true);
  });

  it('keeps the backups when main changed between verification and cleanup', async () => {
    let armed = false;
    let reads = 0;
    fs = {
      ...nodeSwapFs,
      rename: async (from, to) => { await nodeSwapFs.rename(from, to); if (to === mainJson()) armed = true; },
      readFile: async (p) => {
        const text = await nodeSwapFs.readFile(p);
        if (armed && p === mainCreds() && ++reads === 3) return JSON.stringify(creds('X2'));
        return text;
      },
    };
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'manual' });
    expect(json(journalPath()).phase).not.toBe('verified');
    expect(backupFiles()).toContain('main-credentials.json');
  });

  it('does not declare the swap done when main .claude.json was overwritten with the old identity after verification', async () => {
    let armed = false;
    let reads = 0;
    fs = {
      ...nodeSwapFs,
      rename: async (from, to) => { await nodeSwapFs.rename(from, to); if (to === mainJson()) armed = true; },
      readFile: async (p) => {
        const text = await nodeSwapFs.readFile(p);
        if (armed && p === mainJson() && ++reads === 2) return JSON.stringify({ oauthAccount: account('A', 'a@x.com') });
        return text;
      },
    };
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'manual' });
    expect(json(journalPath()).phase).not.toBe('verified');
    expect(backupFiles()).toContain('target-credentials.json');
  });

  it('a completed swap stays ok when cleanup fails, the label is already fixed and the next start cleans up', async () => {
    fs = { ...nodeSwapFs, rm: async (p) => { if (p.includes('swap-backup')) throw Object.assign(new Error('io'), { code: 'EIO' }); return nodeSwapFs.rm(p); } };
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: true, email: 'x@x.com' });
    expect(store.list()[0].email).toBe('a@x.com');
    expect(json(journalPath()).phase).toBe('verified');
    fs = nodeSwapFs;
    expect(await recoverInterruptedSwap(deps())).toBe('none');
    expect(backupFiles()).toEqual([]);
  });

  it('cleans a verified journal whose backups are already gone', async () => {
    await crashed('verified');
    for (const n of backupFiles()) if (n !== 'swap-journal.json') rmSync(join(backup(), n));
    expect(await recoverInterruptedSwap(deps())).toBe('none');
    expect(backupFiles()).toEqual([]);
  });

  it('does not delete the backups of a verified swap when main holds the old main login again', async () => {
    await crashed('verified');
    put(mainCreds(), creds('A'));
    const before = snapshot();
    expect(await recoverInterruptedSwap(deps())).toBe('manual');
    expect(snapshot()).toEqual(before);
    expect(backupFiles()).toContain('target-credentials.json');
  });

  it('fixes the account label when the process died after the verified marker', async () => {
    await crashed('verified');
    store.update(ID, { email: 'x@x.com', org: 'Org X' });
    expect(await recoverInterruptedSwap(deps())).toBe('none');
    expect(store.list()[0]).toMatchObject({ email: 'a@x.com', org: 'Org A' });
    expect(backupFiles()).toEqual([]);
  });

  it('aborts with write before any write when a file cannot be read (not absent)', async () => {
    const before = snapshot();
    fs = { ...nodeSwapFs, readFile: async (p) => { if (p === mainCreds()) throw Object.assign(new Error('io'), { code: 'EIO' }); return nodeSwapFs.readFile(p); } };
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'write' });
    fs = nodeSwapFs;
    expect(snapshot()).toEqual(before);
    expect(existsSync(backup())).toBe(false);
  });

  it('flags an unresolved swap synchronously for background refreshes', async () => {
    let armed = false;
    fs = { ...nodeSwapFs, rename: async (from, to) => { await nodeSwapFs.rename(from, to); if (to === mainJson()) armed = true; },
      readFile: async (p) => { const t = await nodeSwapFs.readFile(p); if (armed && p === mainCreds()) { put(mainCreds(), creds('Z')); armed = false; } return t; } };
    expect(await swapMainAccount(deps(), ID)).toEqual({ ok: false, error: 'manual' });
    expect(isSwapUnresolved()).toBe(true);
    fs = nodeSwapFs;
    expect(await clearPendingSwap(deps())).toBe(true);
    expect(isSwapUnresolved()).toBe(false);
  });
});
