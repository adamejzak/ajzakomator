// src/main/accounts/swap.ts
import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { isAccountId, type SwapError, type SwapRecovery, type SwapResult } from '../../shared/accounts';
import { withProfileLock, type RefreshOutcome } from './refresh';
import type { AccountsStore } from './store';

/*
 * Making a managed account the MAIN one is an EXCHANGE of two login blobs, never a copy: OAuth refresh tokens rotate,
 * so two live copies of one login would invalidate each other. The target's `claudeAiOauth` + `oauthAccount` move to
 * the machine's own Claude config, the old main login moves into the target's profile directory.
 *
 * Guiding principle: a token's lineage follows its POSITION, never stale bytes. Claude Code may rotate the main token
 * at any moment, so every step works on the CURRENT content of the shared files (read again right before each write,
 * guarded by an unchanged-since-read check before every rename attempt), and a rollback is a reverse exchange of the
 * current blobs - it never writes an old copy over a newer token.
 *
 * Crash safety: every file is replaced atomically (temp file + rename). Before anything is written the files that are
 * about to change are copied to `backupDir` (owner-only) and a `swap-journal.json` (account id, timestamp, phase, no
 * secrets) is written; the phase is advanced BEFORE each step starts, so it says how far the swap may have got.
 * After a verified swap the backups and the journal are DELETED (live tokens must not linger). They are kept only
 * when a rollback was not clean or the state is ambiguous. `recoverInterruptedSwap` decides once from the phase and
 * from which login (A = old main, X = the target's) each file's refresh token belongs to; when that is not provable
 * it modifies no credential file and reports 'manual'. On Windows the mode bits are ignored; the directory inherits
 * the ACL of %APPDATA%\ajzakomator (the user's profile), no extra ACL is set.
 */

export interface SwapFs {
  /** File text, or null when the file does not exist or cannot be read. */
  readFile(path: string): Promise<string | null>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export const nodeSwapFs: SwapFs = {
  readFile: (path) => readFile(path, 'utf8').catch(() => null),
  stat: (path) => stat(path).then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }), () => null),
  writeFile: (path, data, mode) => writeFile(path, data, { mode }),
  rename,
  rm: (path) => rm(path, { force: true }),
  mkdir: (path) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined),
};

export interface SwapDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  store: Pick<AccountsStore, 'list' | 'dirOf' | 'update'>;
  /** `<userData>/accounts/swap-backup`. */
  backupDir: string;
  now(): number;
  /** Renews a managed profile (`refreshClaudeProfile` bound to its network deps). */
  refresh(dir: string): Promise<RefreshOutcome>;
  delay(ms: number): Promise<void>;
  fs?: SwapFs;
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_RETRIES = 5;
const MAX_TRIES = 3;
const EXPIRY_MARGIN_MS = 60_000;
const JOURNAL = 'swap-journal.json';
const BACKUP = { mainCreds: 'main-credentials.json', mainJson: 'main-claude.json', targetCreds: 'target-credentials.json', targetJson: 'target-claude.json' };

type Phase = 'backed-up' | 'target-written' | 'main-creds-written' | 'main-json-written' | 'rolling-back' | 'verified';

class Fail extends Error {
  constructor(readonly code: SwapError) { super(code); }
}
/** A shared file changed between our read and our rename; the caller re-reads and recomputes. */
class Changed extends Error {}

let running = false;
/** True while a swap runs; the login flow must not start meanwhile. */
export function isSwapRunning(): boolean { return running; }

interface Snap { text: string; data: Rec; sig: string }
interface Identity { uuid?: string; email: string; org?: string }

/** Where the main login lives, or null when CLAUDE_CONFIG_DIR is set but not absolute (never resolved against the cwd). */
export function swapPaths(deps: Pick<SwapDeps, 'home' | 'env'>): { credentials: string; claudeJson: string } | null {
  const custom = deps.env.CLAUDE_CONFIG_DIR?.trim();
  if (custom && !isAbsolute(custom)) return null;
  const configDir = custom || join(deps.home, '.claude');
  return { credentials: join(configDir, '.credentials.json'), claudeJson: custom ? join(custom, '.claude.json') : join(deps.home, '.claude.json') };
}

async function readSnap(fs: SwapFs, path: string): Promise<Snap | null> {
  const before = await fs.stat(path);
  const text = await fs.readFile(path);
  if (text === null || !before) return null;
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? { text, data, sig: `${before.mtimeMs}:${before.size}` } : null;
  } catch { return null; }
}

/** True while the file is still exactly what `snap` read (checked again before every rename attempt). */
const unchanged = (fs: SwapFs, path: string, snap: Snap) => async (): Promise<boolean> => {
  const now = await readSnap(fs, path);
  return now !== null && now.sig === snap.sig && now.text === snap.text;
};

async function retry<T>(deps: Pick<SwapDeps, 'delay'>, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (i >= MAX_RETRIES || typeof code !== 'string' || !RETRY_CODES.has(code)) throw error;
      await deps.delay(50 + ((i * 17) % 51));
    }
  }
}

/** Temp file next to the target + rename. `guard` runs before EVERY rename attempt; false means the file changed meanwhile. */
async function atomicWrite(deps: Pick<SwapDeps, 'delay'>, fs: SwapFs, path: string, data: string, guard?: () => Promise<boolean>): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await retry(deps, () => fs.writeFile(temp, data, 0o600));
    await retry(deps, async () => {
      if (guard && !(await guard())) throw new Changed();
      await fs.rename(temp, path);
    });
  } catch (error) {
    await fs.rm(temp).catch(() => undefined);
    throw error;
  }
}

function identityOf(account: unknown, fallback?: { email?: string; org?: string }): Identity | null {
  const a = isRecord(account) ? account : {};
  const email = str(a.emailAddress) ?? str(fallback?.email);
  if (!email) return null;
  const org = str(a.organizationName) ?? (a.emailAddress === undefined || str(a.emailAddress) === undefined ? str(fallback?.org) : undefined);
  return { uuid: str(a.accountUuid), email: email.toLowerCase(), org: org?.toLowerCase() };
}

/** Conservative: an unknown organisation or a missing uuid never makes two logins look different. */
function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.uuid && b.uuid) return a.uuid === b.uuid;
  if (a.email !== b.email) return false;
  return a.org === undefined || b.org === undefined || a.org === b.org;
}

const oauthOf = (data: Rec): Rec | null => (isRecord(data.claudeAiOauth) ? data.claudeAiOauth : null);
const validOauth = (o: Rec | null): o is Rec => o !== null && !!str(o.accessToken) && !!str(o.refreshToken);

interface Paths { credentials: string; claudeJson: string }
interface State {
  mainCreds: Snap; mainJson: Snap; targetCreds: Snap; targetJson: Snap | null;
  mainOauth: Rec; targetOauth: Rec; mainAccount: Rec; targetAccount: Rec;
  mainIdentity: Identity; targetIdentity: Identity;
}

async function inspect(deps: SwapDeps, fs: SwapFs, paths: Paths, accountId: string): Promise<State> {
  const entry = deps.store.list().find((a) => a.id === accountId);
  if (!entry) throw new Fail('noTarget');
  const targetDir = deps.store.dirOf(accountId);
  const mainCreds = await readSnap(fs, paths.credentials);
  const mainJson = await readSnap(fs, paths.claudeJson);
  const mainOauth = mainCreds ? oauthOf(mainCreds.data) : null;
  if (!mainCreds || !mainJson || !validOauth(mainOauth)) throw new Fail('noMain');
  const mainAccount = isRecord(mainJson.data.oauthAccount) ? mainJson.data.oauthAccount : null;
  const mainIdentity = identityOf(mainAccount);
  if (!mainAccount || !mainIdentity) throw new Fail('noMain');

  const targetCreds = await readSnap(fs, join(targetDir, '.credentials.json'));
  const targetOauth = targetCreds ? oauthOf(targetCreds.data) : null;
  if (!targetCreds || !targetOauth || !str(targetOauth.accessToken)) throw new Fail('noTarget');
  const targetJson = await readSnap(fs, join(targetDir, '.claude.json'));
  const fileAccount = targetJson && isRecord(targetJson.data.oauthAccount) ? targetJson.data.oauthAccount : null;
  const targetIdentity = identityOf(fileAccount, entry);
  if (!targetIdentity) throw new Fail('noTarget');
  // An account object without an e-mail is completed from the stored entry.
  const targetAccount: Rec = fileAccount
    ? (str(fileAccount.emailAddress) ? fileAccount : { ...fileAccount, emailAddress: entry.email, ...(entry.org && !str(fileAccount.organizationName) ? { organizationName: entry.org } : {}) })
    : { emailAddress: entry.email, ...(entry.org ? { organizationName: entry.org } : {}) };
  if (sameIdentity(mainIdentity, targetIdentity)) throw new Fail('sameAccount');

  for (const other of deps.store.list()) {
    if (other.id === accountId) continue;
    const otherJson = await readSnap(fs, join(deps.store.dirOf(other.id), '.claude.json'));
    const otherIdentity = identityOf(otherJson?.data.oauthAccount, other);
    if (otherIdentity && sameIdentity(otherIdentity, mainIdentity)) throw new Fail('duplicate');
  }
  return { mainCreds, mainJson, targetCreds, targetJson, mainOauth, targetOauth, mainAccount, targetAccount, mainIdentity, targetIdentity };
}

/** Swaps the main Claude login with the one saved in managed account `accountId`. Never throws; never exposes a token. */
export async function swapMainAccount(deps: SwapDeps, accountId: string): Promise<SwapResult> {
  if (deps.platform === 'darwin') return { ok: false, error: 'unsupported' };
  if (!isAccountId(accountId)) return { ok: false, error: 'invalid' };
  if (running) return { ok: false, error: 'busy' };
  running = true;
  try {
    return await perform(deps, deps.fs ?? nodeSwapFs, accountId);
  } catch (error) {
    return { ok: false, error: error instanceof Fail ? error.code : 'write' };
  } finally {
    running = false;
  }
}

async function perform(deps: SwapDeps, fs: SwapFs, accountId: string): Promise<SwapResult> {
  if (deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) throw new Fail('envToken');
  const paths = swapPaths(deps);
  if (!paths) throw new Fail('noMain');
  await inspect(deps, fs, paths, accountId);

  const targetDir = deps.store.dirOf(accountId);
  let outcome: RefreshOutcome;
  try { outcome = await deps.refresh(targetDir); } catch { outcome = { kind: 'transient' }; }
  if (outcome.kind === 'dead') throw new Fail('dead');
  return withProfileLock(targetDir, () => runSwap(deps, fs, paths, accountId, targetDir, outcome.kind === 'transient'));
}

interface Ctx {
  deps: SwapDeps; fs: SwapFs; paths: Paths; s: State; accountId: string;
  targetCredsPath: string; targetJsonPath: string;
  targetCredsWritten: boolean; targetJsonWritten: boolean; mainCredsReplaced: boolean; mainJsonReplaced: boolean;
  phase: Phase | null;
}

const write = (c: Ctx, path: string, data: string, guard?: () => Promise<boolean>) => atomicWrite(c.deps, c.fs, path, data, guard);

async function journal(c: Ctx, phase: Phase): Promise<void> {
  if (c.phase === phase) return;
  await write(c, join(c.deps.backupDir, JOURNAL), JSON.stringify({ version: 1, accountId: c.accountId, startedAt: c.deps.now(), phase, targetJsonExisted: c.s.targetJson !== null }));
  c.phase = phase;
}

/**
 * Moves the CURRENT main blob into the target profile and `toMain` into main. Main is re-read on every try and guarded
 * right before every rename attempt; when Claude Code wrote meanwhile the target copy is recomputed from the fresh blob.
 */
async function exchangeCreds(c: Ctx, toMain: Rec, journaled: boolean): Promise<void> {
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const main = await readSnap(c.fs, c.paths.credentials);
    const mainOauth = main ? oauthOf(main.data) : null;
    if (!main || !validOauth(mainOauth)) throw new Fail('write');
    const target = await readSnap(c.fs, c.targetCredsPath);
    if (journaled) await journal(c, 'target-written');
    await write(c, c.targetCredsPath, JSON.stringify({ ...(target?.data ?? c.s.targetCreds.data), claudeAiOauth: mainOauth }));
    c.targetCredsWritten = true;
    if (journaled) await journal(c, 'main-creds-written');
    try {
      await write(c, c.paths.credentials, JSON.stringify({ ...main.data, claudeAiOauth: toMain }), unchanged(c.fs, c.paths.credentials, main));
      c.mainCredsReplaced = true;
      return;
    } catch (error) { if (!(error instanceof Changed)) throw error; }
  }
  throw new Fail('write');
}

/** Sets one key of a JSON file from its current content (guarded and recomputed on change when `guarded`). */
async function setKey(deps: SwapDeps, fs: SwapFs, path: string, key: string, value: unknown, guarded: boolean, accept?: (data: Rec) => boolean): Promise<void> {
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const snap = await readSnap(fs, path);
    if (!snap || (accept && !accept(snap.data))) throw new Fail('write');
    try {
      await atomicWrite(deps, fs, path, JSON.stringify({ ...snap.data, [key]: value }, null, 2), guarded ? unchanged(fs, path, snap) : undefined);
      return;
    } catch (error) { if (!(error instanceof Changed)) throw error; }
  }
  throw new Fail('write');
}

async function removeBackups(deps: SwapDeps, fs: SwapFs): Promise<void> {
  for (const name of [...Object.values(BACKUP), JOURNAL]) await fs.rm(join(deps.backupDir, name)).catch(() => undefined);
}

async function runSwap(deps: SwapDeps, fs: SwapFs, paths: Paths, accountId: string, targetDir: string, requireValidToken: boolean): Promise<SwapResult> {
  const s = await inspect(deps, fs, paths, accountId);
  if (requireValidToken) {
    const expiresAt = s.targetOauth.expiresAt;
    if (typeof expiresAt !== 'number' || expiresAt <= deps.now() + EXPIRY_MARGIN_MS) throw new Fail('transient');
  }
  const c: Ctx = {
    deps, fs, paths, s, accountId, targetCredsPath: join(targetDir, '.credentials.json'), targetJsonPath: join(targetDir, '.claude.json'),
    targetCredsWritten: false, targetJsonWritten: false, mainCredsReplaced: false, mainJsonReplaced: false, phase: null,
  };
  const jr = (phase: Phase) => journal(c, phase);

  try {
    await fs.mkdir(deps.backupDir);
    await write(c, join(deps.backupDir, BACKUP.mainCreds), s.mainCreds.text);
    await write(c, join(deps.backupDir, BACKUP.mainJson), s.mainJson.text);
    await write(c, join(deps.backupDir, BACKUP.targetCreds), s.targetCreds.text);
    if (s.targetJson) await write(c, join(deps.backupDir, BACKUP.targetJson), s.targetJson.text);
    else await fs.rm(join(deps.backupDir, BACKUP.targetJson));
    await jr('backed-up');

    // 1. target profile: identity, then credentials (together with main credentials)
    await jr('target-written');
    await write(c, c.targetJsonPath, JSON.stringify({ ...(s.targetJson?.data ?? {}), oauthAccount: s.mainAccount }, null, 2));
    c.targetJsonWritten = true;
    await exchangeCreds(c, s.targetOauth, true);

    // 2. main identity
    await jr('main-json-written');
    await setKey(deps, fs, paths.claudeJson, 'oauthAccount', s.targetAccount, true, (data) => {
      const id = identityOf(data.oauthAccount);
      return id !== null && sameIdentity(id, s.mainIdentity);
    });
    c.mainJsonReplaced = true;

    // 3. verify by reading everything back (a refreshed access token is fine; identity and a usable login are checked)
    const main = await readSnap(fs, paths.credentials);
    const mainJson = await readSnap(fs, paths.claudeJson);
    const target = await readSnap(fs, c.targetCredsPath);
    const targetJson = await readSnap(fs, c.targetJsonPath);
    const mainIdentity = identityOf(mainJson?.data.oauthAccount);
    const targetIdentity = identityOf(targetJson?.data.oauthAccount);
    if (!main || !validOauth(oauthOf(main.data)) || !target || !validOauth(oauthOf(target.data)) || !mainIdentity || !targetIdentity
      || !sameIdentity(mainIdentity, s.targetIdentity) || !sameIdentity(targetIdentity, s.mainIdentity)) throw new Fail('write');
    await jr('verified');
  } catch (error) {
    const clean = await rollback(c, jr);
    if (!clean) throw new Fail('manual');
    await removeBackups(deps, fs);
    throw error instanceof Fail && error.code !== 'manual' ? error : new Fail('write');
  }

  await removeBackups(deps, fs);
  try {
    deps.store.update(accountId, { email: str(s.mainAccount.emailAddress), org: str(s.mainAccount.organizationName) });
  } catch { /* the swap itself is done; only the list label is stale */ }
  return { ok: true, email: str(s.targetAccount.emailAddress) };
}

/**
 * Undoes a failed swap on the CURRENT content. Before main was replaced only the target profile was touched and its
 * own originals go back. Afterwards it is a reverse exchange: the blob now in main (the target account's login,
 * possibly rotated by Claude Code) returns to the target profile and the blob now in the target profile (the old
 * main login) returns to main. Returns false when anything could not be undone (nothing is retried then).
 */
async function rollback(c: Ctx, jr: (phase: Phase) => Promise<void>): Promise<boolean> {
  const { deps, fs, s } = c;
  let clean = true;
  const step = async (fn: () => Promise<void>) => { try { await fn(); } catch { clean = false; } };
  if (c.mainCredsReplaced) {
    await step(() => jr('rolling-back'));
    await step(async () => {
      const target = await readSnap(fs, c.targetCredsPath);
      const back = target ? oauthOf(target.data) : null;
      if (!validOauth(back)) throw new Fail('manual');
      await exchangeCreds(c, back, false);
    });
  } else if (c.targetCredsWritten) {
    await step(() => write(c, c.targetCredsPath, s.targetCreds.text));
  }
  if (c.targetJsonWritten) {
    await step(() => (s.targetJson ? write(c, c.targetJsonPath, s.targetJson.text) : fs.rm(c.targetJsonPath)));
  }
  if (c.mainCredsReplaced) {
    await step(async () => {
      const now = await readSnap(fs, c.paths.claudeJson);
      const id = now ? identityOf(now.data.oauthAccount) : null;
      if (id && sameIdentity(id, s.mainIdentity)) return;
      await setKey(deps, fs, c.paths.claudeJson, 'oauthAccount', s.mainAccount, true);
    });
  }
  return clean;
}

type Lineage = 'A' | 'X' | 'unknown' | 'none';

/**
 * Call once at app start. Decides once for the whole interrupted swap from the journal phase and from which login each
 * credentials file holds (A = the old main login, X = the target's), by refresh token against the backups. It acts
 * only when that is provable; otherwise nothing is modified, backup and journal stay, and 'manual' is returned.
 * Only the `claudeAiOauth` / `oauthAccount` keys are ever written.
 */
export async function recoverInterruptedSwap(deps: SwapDeps): Promise<SwapRecovery> {
  const fs = deps.fs ?? nodeSwapFs;
  const journalText = await fs.readFile(join(deps.backupDir, JOURNAL));
  if (journalText === null) return 'none';
  let info: unknown;
  try { info = JSON.parse(journalText); } catch { info = null; }
  if (!isRecord(info) || !isAccountId(info.accountId) || typeof info.phase !== 'string') return 'manual';
  const accountId = info.accountId;
  const phase = info.phase as Phase;
  if (phase === 'verified' || phase === 'backed-up') { await removeBackups(deps, fs); return 'none'; }
  const paths = swapPaths(deps);
  if (!paths) return 'manual';

  const read = async (name: string) => {
    const text = await fs.readFile(join(deps.backupDir, name));
    try { const data: unknown = text === null ? null : JSON.parse(text); return isRecord(data) ? data : null; } catch { return null; }
  };
  const mainCredsB = await read(BACKUP.mainCreds);
  const mainJsonB = await read(BACKUP.mainJson);
  const targetCredsB = await read(BACKUP.targetCreds);
  const targetJsonB = await read(BACKUP.targetJson);
  const aBlob = mainCredsB ? oauthOf(mainCredsB) : null;
  const xBlob = targetCredsB ? oauthOf(targetCredsB) : null;
  if (!validOauth(aBlob) || !validOauth(xBlob) || !mainJsonB || !isRecord(mainJsonB.oauthAccount)) return 'manual';
  const accountA = mainJsonB.oauthAccount;

  const classify = (snap: Snap | null): Lineage => {
    const o = snap ? oauthOf(snap.data) : null;
    const refresh = o ? str(o.refreshToken) : undefined;
    if (!refresh) return 'none';
    return refresh === aBlob.refreshToken ? 'A' : refresh === xBlob.refreshToken ? 'X' : 'unknown';
  };

  const targetDir = deps.store.dirOf(accountId);
  const targetCredsPath = join(targetDir, '.credentials.json');
  const targetJsonPath = join(targetDir, '.claude.json');
  try {
    const outcome = await withProfileLock(targetDir, async (): Promise<SwapRecovery> => {
      const main = classify(await readSnap(fs, paths.credentials));
      const targetSnap = await readSnap(fs, targetCredsPath);
      const target = classify(targetSnap);
      const entry = deps.store.list().find((a) => a.id === accountId);
      const accountX: Rec = targetJsonB && isRecord(targetJsonB.oauthAccount)
        ? targetJsonB.oauthAccount
        : { emailAddress: entry?.email, ...(entry?.org ? { organizationName: entry.org } : {}) };
      const setTargetAccount = async (value: Rec | undefined) => {
        const cur = await readSnap(fs, targetJsonPath);
        if (value === undefined) {
          if (!cur) return;
          const { oauthAccount: _drop, ...rest } = cur.data;
          if (Object.keys(rest).length === 0) await fs.rm(targetJsonPath);
          else await atomicWrite(deps, fs, targetJsonPath, JSON.stringify(rest, null, 2));
          return;
        }
        await atomicWrite(deps, fs, targetJsonPath, JSON.stringify({ ...(cur?.data ?? {}), oauthAccount: value }, null, 2));
      };
      const setMainAccount = async (value: Rec) => {
        const cur = await readSnap(fs, paths.claudeJson);
        const id = cur ? identityOf(cur.data.oauthAccount) : null;
        const want = identityOf(value);
        if (id && want && sameIdentity(id, want)) return;
        await setKey(deps, fs, paths.claudeJson, 'oauthAccount', value, true);
      };

      const originalPositions = main === 'A' && target === 'X';
      const targetCopiedOnly = main === 'A' && target === 'A' && (phase === 'target-written' || phase === 'main-creds-written' || phase === 'main-json-written');
      if (originalPositions || targetCopiedOnly) {
        // Main still holds exactly the old main login: the target profile gets its own login back.
        if (targetCopiedOnly) await atomicWrite(deps, fs, targetCredsPath, JSON.stringify({ ...(targetSnap?.data ?? {}), claudeAiOauth: xBlob }));
        await setTargetAccount(targetJsonB && isRecord(targetJsonB.oauthAccount) ? targetJsonB.oauthAccount : undefined);
        await setMainAccount(accountA);
        return 'recovered';
      }
      if (main === 'X' && target === 'A' && (phase === 'main-creds-written' || phase === 'main-json-written' || phase === 'rolling-back')) {
        // The credentials were exchanged: finish the identity half.
        await setTargetAccount(accountA);
        await setMainAccount(accountX);
        try { deps.store.update(accountId, { email: str(accountA.emailAddress), org: str(accountA.organizationName) }); } catch { /* label only */ }
        return 'recovered';
      }
      return 'manual';
    });
    if (outcome === 'recovered') await removeBackups(deps, fs);
    return outcome;
  } catch {
    return 'manual';
  }
}
