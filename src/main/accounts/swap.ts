// src/main/accounts/swap.ts
import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { isAccountId, type SwapError, type SwapResult } from '../../shared/accounts';
import { withProfileLock, type RefreshOutcome } from './refresh';
import type { AccountsStore } from './store';

/*
 * Making a managed account the MAIN one is an EXCHANGE of two login blobs, never a copy: OAuth refresh tokens rotate,
 * so two live copies of one login would invalidate each other. The target's `claudeAiOauth` + `oauthAccount` move to
 * the machine's own Claude config, the old main login moves into the target's profile directory.
 *
 * Crash safety: every file is replaced atomically (temp file + rename). Before anything is written, the four files that
 * are about to change are copied to `<backupDir>` (owner-only) together with a small `swap-journal.json` (no secrets:
 * account id and timestamp). The journal is removed once the result was verified (or the rollback finished). If the
 * app dies in between, `recoverInterruptedSwap` runs at the next start and restores the pre-swap files, but only
 * those whose current tokens still match one of the two blobs involved - so a token that Claude Code refreshed
 * meanwhile is never overwritten by an older one. The backup directory is kept after a successful swap
 * (it holds the previous state of the last swap, overwritten by the next one).
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
const MAX_ATTEMPTS = 3;
const EXPIRY_MARGIN_MS = 60_000;
const JOURNAL = 'swap-journal.json';
const BACKUP = { mainCreds: 'main-credentials.json', mainJson: 'main-claude.json', targetCreds: 'target-credentials.json', targetJson: 'target-claude.json' };

class Fail extends Error {
  constructor(readonly code: SwapError) { super(code); }
}
/** A shared file changed under us; the attempt is rolled back and repeated. */
class Changed extends Error {}

let running = false;
/** True while a swap runs; the login flow must not start meanwhile. */
export function isSwapRunning(): boolean { return running; }

interface Snap { text: string; data: Rec; sig: string }
interface Identity { uuid?: string; email: string; org: string }

export function swapPaths(deps: Pick<SwapDeps, 'home' | 'env'>): { credentials: string; claudeJson: string } {
  const custom = deps.env.CLAUDE_CONFIG_DIR?.trim();
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

async function signature(fs: SwapFs, path: string): Promise<string | null> {
  const s = await fs.stat(path);
  return s ? `${s.mtimeMs}:${s.size}` : null;
}

async function retry<T>(deps: Pick<SwapDeps, 'delay'>, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (i >= MAX_RETRIES || typeof code !== 'string' || !RETRY_CODES.has(code)) throw error;
      await deps.delay(50 + ((i * 17) % 51));
    }
  }
}

/** Temp file next to the target + rename. `guard` runs just before the rename; false means the file changed meanwhile. */
async function atomicWrite(deps: Pick<SwapDeps, 'delay'>, fs: SwapFs, path: string, data: string, guard?: () => Promise<boolean>): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await retry(deps, () => fs.writeFile(temp, data, 0o600));
    if (guard && !(await guard())) throw new Changed();
    await retry(deps, () => fs.rename(temp, path));
  } catch (error) {
    await fs.rm(temp).catch(() => undefined);
    throw error;
  }
}

function identityOf(account: unknown, fallback?: { email?: string; org?: string }): Identity | null {
  const a = isRecord(account) ? account : {};
  const email = str(a.emailAddress) ?? (isRecord(account) ? undefined : fallback?.email);
  if (!email) return null;
  return { uuid: str(a.accountUuid), email: email.toLowerCase(), org: (str(a.organizationName) ?? (isRecord(account) ? undefined : fallback?.org) ?? '').toLowerCase() };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.uuid && b.uuid) return a.uuid === b.uuid;
  return a.email === b.email && a.org === b.org;
}

const oauthOf = (data: Rec): Rec | null => (isRecord(data.claudeAiOauth) ? data.claudeAiOauth : null);

interface State {
  mainCreds: Snap; mainJson: Snap; targetCreds: Snap; targetJson: Snap | null;
  mainOauth: Rec; targetOauth: Rec; mainAccount: Rec; targetAccount: Rec;
  mainIdentity: Identity;
}

async function inspect(deps: SwapDeps, fs: SwapFs, accountId: string): Promise<State> {
  const paths = swapPaths(deps);
  const entry = deps.store.list().find((a) => a.id === accountId);
  if (!entry) throw new Fail('noTarget');
  const targetDir = deps.store.dirOf(accountId);
  const mainCreds = await readSnap(fs, paths.credentials);
  const mainJson = await readSnap(fs, paths.claudeJson);
  const mainOauth = mainCreds ? oauthOf(mainCreds.data) : null;
  if (!mainCreds || !mainJson || !mainOauth || !str(mainOauth.accessToken) || !str(mainOauth.refreshToken)) throw new Fail('noMain');
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
  const targetAccount: Rec = fileAccount ?? { emailAddress: entry.email, ...(entry.org ? { organizationName: entry.org } : {}) };
  if (sameIdentity(mainIdentity, targetIdentity)) throw new Fail('sameAccount');

  for (const other of deps.store.list()) {
    if (other.id === accountId) continue;
    const otherJson = await readSnap(fs, join(deps.store.dirOf(other.id), '.claude.json'));
    const otherIdentity = identityOf(otherJson && isRecord(otherJson.data.oauthAccount) ? otherJson.data.oauthAccount : undefined, other)
      ?? identityOf(undefined, other);
    if (otherIdentity && sameIdentity(otherIdentity, mainIdentity)) throw new Fail('duplicate');
  }
  return { mainCreds, mainJson, targetCreds, targetJson, mainOauth, targetOauth, mainAccount, targetAccount, mainIdentity };
}

interface Written { restore(): Promise<void> }

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
  await inspect(deps, fs, accountId);

  const targetDir = deps.store.dirOf(accountId);
  let outcome: RefreshOutcome;
  try { outcome = await deps.refresh(targetDir); } catch { outcome = { kind: 'transient' }; }
  if (outcome.kind === 'dead') throw new Fail('dead');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await withProfileLock(targetDir, () => runAttempt(deps, fs, accountId, targetDir, outcome.kind === 'transient'));
    if (result) return result;
  }
  throw new Fail('write');
}

/** One locked pass over steps 4-7; null means "a shared file changed, everything was rolled back, try again". */
async function runAttempt(deps: SwapDeps, fs: SwapFs, accountId: string, targetDir: string, requireValidToken: boolean): Promise<SwapResult | null> {
  const paths = swapPaths(deps);
  const s = await inspect(deps, fs, accountId);
  if (requireValidToken) {
    const expiresAt = s.targetOauth.expiresAt;
    if (typeof expiresAt !== 'number' || expiresAt <= deps.now() + EXPIRY_MARGIN_MS) throw new Fail('transient');
  }
  const entry = deps.store.list().find((a) => a.id === accountId);
  const targetCredsPath = join(targetDir, '.credentials.json');
  const targetJsonPath = join(targetDir, '.claude.json');
  const write = (path: string, data: string, guard?: () => Promise<boolean>) => atomicWrite(deps, fs, path, data, guard);
  const written: Written[] = [];
  let journaled = false;

  const rollback = async (): Promise<boolean> => {
    let clean = true;
    for (const w of written.reverse()) { try { await w.restore(); } catch { clean = false; } }
    return clean;
  };

  try {
    // Backup of everything that is about to change, then the journal marker.
    await fs.mkdir(deps.backupDir);
    await write(join(deps.backupDir, BACKUP.mainCreds), s.mainCreds.text);
    await write(join(deps.backupDir, BACKUP.mainJson), s.mainJson.text);
    await write(join(deps.backupDir, BACKUP.targetCreds), s.targetCreds.text);
    if (s.targetJson) await write(join(deps.backupDir, BACKUP.targetJson), s.targetJson.text);
    else await fs.rm(join(deps.backupDir, BACKUP.targetJson));
    await write(join(deps.backupDir, JOURNAL), JSON.stringify({ version: 1, accountId, startedAt: deps.now(), targetJsonExisted: s.targetJson !== null }));
    journaled = true;

    // 1. target profile gets the old main login
    const targetCredsText = JSON.stringify({ ...s.targetCreds.data, claudeAiOauth: s.mainOauth });
    await write(targetCredsPath, targetCredsText);
    written.push({ restore: () => write(targetCredsPath, s.targetCreds.text) });
    const targetJsonText = JSON.stringify({ ...(s.targetJson?.data ?? {}), oauthAccount: s.mainAccount }, null, 2);
    await write(targetJsonPath, targetJsonText);
    written.push({ restore: () => (s.targetJson ? write(targetJsonPath, s.targetJson.text) : fs.rm(targetJsonPath)) });

    // 2. main credentials (guarded: Claude Code may have refreshed them meanwhile, then the whole pass is redone)
    const mainCredsText = JSON.stringify({ ...s.mainCreds.data, claudeAiOauth: s.targetOauth });
    await write(paths.credentials, mainCredsText, async () => (await signature(fs, paths.credentials)) === s.mainCreds.sig);
    written.push({ restore: () => restoreKey(deps, fs, paths.credentials, 'claudeAiOauth', s.mainCreds, mainCredsText) });

    // 3. main identity (this file is rewritten by Claude Code all the time: re-read and retry in place)
    let jsonText = '';
    let snap: Snap = s.mainJson;
    for (let tries = 0; ; tries++) {
      if (tries >= MAX_ATTEMPTS) throw new Fail('write');
      if (tries > 0) {
        const fresh = await readSnap(fs, paths.claudeJson);
        const freshIdentity = fresh && identityOf(fresh.data.oauthAccount);
        if (!fresh || !freshIdentity || !sameIdentity(freshIdentity, s.mainIdentity)) throw new Changed();
        snap = fresh;
      }
      jsonText = JSON.stringify({ ...snap.data, oauthAccount: s.targetAccount }, null, 2);
      const expected = snap.sig;
      try {
        await write(paths.claudeJson, jsonText, async () => (await signature(fs, paths.claudeJson)) === expected);
        break;
      } catch (error) { if (!(error instanceof Changed)) throw error; }
    }
    const writtenJson = jsonText;
    written.push({ restore: () => restoreKey(deps, fs, paths.claudeJson, 'oauthAccount', s.mainJson, writtenJson) });

    // 4. verify by reading everything back
    const check = await readSnap(fs, paths.credentials);
    const checkJson = await readSnap(fs, paths.claudeJson);
    const targetIdentity = identityOf(s.targetAccount, entry);
    const nowIdentity = checkJson && identityOf(checkJson.data.oauthAccount);
    if (!check || oauthOf(check.data)?.accessToken !== s.targetOauth.accessToken || !nowIdentity || !targetIdentity || !sameIdentity(nowIdentity, targetIdentity)) {
      throw new Fail('write');
    }
    await fs.rm(join(deps.backupDir, JOURNAL));
    journaled = false;
  } catch (error) {
    const clean = await rollback();
    if (clean && journaled) await fs.rm(join(deps.backupDir, JOURNAL)).catch(() => undefined);
    if (error instanceof Changed) return null;
    throw error instanceof Fail && error.code !== 'write' ? error : new Fail('write');
  }

  // 5. the profile directory now holds the previous main login
  try {
    deps.store.update(accountId, { email: str(s.mainAccount.emailAddress), org: str(s.mainAccount.organizationName) });
  } catch { /* the swap itself is done; only the list label is stale */ }
  return { ok: true, email: str(s.targetAccount.emailAddress) };
}

/**
 * Puts one key back into a shared file. If the file still holds exactly what the swap wrote, the original bytes come
 * back; otherwise (Claude Code changed it since) only the swapped key is reset so unrelated updates survive.
 */
async function restoreKey(deps: SwapDeps, fs: SwapFs, path: string, key: string, original: Snap, writtenText: string): Promise<void> {
  const current = await fs.readFile(path);
  if (current === writtenText) return atomicWrite(deps, fs, path, original.text);
  let data: unknown;
  try { data = current === null ? null : JSON.parse(current); } catch { data = null; }
  if (!isRecord(data)) return atomicWrite(deps, fs, path, original.text);
  const indent = key === 'oauthAccount' ? 2 : undefined;
  return atomicWrite(deps, fs, path, JSON.stringify({ ...data, [key]: original.data[key] }, null, indent));
}

/**
 * Call once at app start. When a journal from an interrupted swap exists, the pre-swap files are restored, each pair
 * only if its current tokens still belong to one of the two logins involved (otherwise Claude Code refreshed them
 * since and they are left alone). Returns true when a journal was found and handled.
 */
export async function recoverInterruptedSwap(deps: SwapDeps): Promise<boolean> {
  const fs = deps.fs ?? nodeSwapFs;
  const journalText = await fs.readFile(join(deps.backupDir, JOURNAL));
  if (journalText === null) return false;
  try {
    let journal: unknown;
    try { journal = JSON.parse(journalText); } catch { journal = null; }
    if (!isRecord(journal) || !isAccountId(journal.accountId)) { await fs.rm(join(deps.backupDir, JOURNAL)); return true; }
    const targetDir = deps.store.dirOf(journal.accountId);
    const paths = swapPaths(deps);
    const backup = async (name: string) => fs.readFile(join(deps.backupDir, name));
    const tokensOf = (text: string | null): string[] => {
      try {
        const data: unknown = text === null ? null : JSON.parse(text);
        const o = isRecord(data) ? oauthOf(data) : null;
        return o ? [str(o.accessToken), str(o.refreshToken)].filter((t): t is string => !!t) : [];
      } catch { return []; }
    };
    const mainCredsBackup = await backup(BACKUP.mainCreds);
    const mainJsonBackup = await backup(BACKUP.mainJson);
    const targetCredsBackup = await backup(BACKUP.targetCreds);
    const targetJsonBackup = await backup(BACKUP.targetJson);
    if (mainCredsBackup === null || mainJsonBackup === null || targetCredsBackup === null) { await fs.rm(join(deps.backupDir, JOURNAL)); return true; }
    const known = new Set([...tokensOf(mainCredsBackup), ...tokensOf(targetCredsBackup)]);
    const ours = async (path: string) => {
      const tokens = tokensOf(await fs.readFile(path));
      return tokens.length === 0 || tokens.some((t) => known.has(t));
    };

    await withProfileLock(targetDir, async () => {
      const targetCredsPath = join(targetDir, '.credentials.json');
      if (await ours(targetCredsPath)) {
        await atomicWrite(deps, fs, targetCredsPath, targetCredsBackup);
        if (journal.targetJsonExisted === false || targetJsonBackup === null) await fs.rm(join(targetDir, '.claude.json'));
        else await atomicWrite(deps, fs, join(targetDir, '.claude.json'), targetJsonBackup);
      }
      if (await ours(paths.credentials)) {
        await atomicWrite(deps, fs, paths.credentials, mainCredsBackup);
        const current = await fs.readFile(paths.claudeJson);
        let data: unknown;
        try { data = current === null ? null : JSON.parse(current); } catch { data = null; }
        let original: unknown;
        try { original = JSON.parse(mainJsonBackup); } catch { original = null; }
        if (isRecord(data) && isRecord(original)) await atomicWrite(deps, fs, paths.claudeJson, JSON.stringify({ ...data, oauthAccount: original.oauthAccount }, null, 2));
        else await atomicWrite(deps, fs, paths.claudeJson, mainJsonBackup);
      }
    });
    await fs.rm(join(deps.backupDir, JOURNAL));
    return true;
  } catch {
    return false; // journal kept, the next start tries again
  }
}
