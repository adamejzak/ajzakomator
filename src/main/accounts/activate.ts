// "Set as main" (0.9.1). The outgoing live login is saved into ITS record (a new record when the app does not know the
// account), then the target's login is written into Claude Code's files - all under Claude Code's credential and config
// locks, so neither Claude Code nor cswap can write in between, and with no network while they are held. The target keeps
// its profile copy as a backup that is never renewed while it is live. A version-2 journal plus backups make an interrupted
// swap recoverable; the 0.9.0 exchange in swap.ts only remains for its version-1 journals.
import { join } from 'path';
import {
  compareIdentity, custodyOf, identityFields, identityFromOauthAccount, isAccountId,
  type AccountIdentity, type ManagedAccount, type SwapError, type SwapRecovery, type SwapResult,
} from '../../shared/accounts';
import { LockTimeout, withClaudeLocks, type LockDeps } from './claudeLocks';
import type { CswapRoster } from './cswap';
import { gateFamilyRefresh } from './guards';
import { renewRule } from './refs';
import { withProfileLock, type RefreshOutcome } from './refresh';
import type { AccountsStore } from './store';
import {
  atomicWrite, claimSwap, hasPendingSwap, isRecord, nodeSwapFs, readSnap, releaseSwap, setSwapUnresolved, str, swapPaths, validOauth,
  type Snap, type SwapFs,
} from './swap';

export interface ActivateDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  store: AccountsStore;
  /** `<data>/accounts/swap-backup`, shared with the 0.9.0 swap: one pending journal blocks both. */
  backupDir: string;
  now(): number;
  /** Renews a saved profile (`refreshClaudeProfile` bound to its network deps); only called through `gateFamilyRefresh`. */
  refresh(dir: string): Promise<RefreshOutcome>;
  delay(ms: number): Promise<void>;
  /** cswap's roster (R7); `{ present: false }` without cswap. */
  cswap(): Promise<CswapRoster>;
  fs?: SwapFs;
  locks?: LockDeps;
}

type Rec = Record<string, unknown>;
type Paths = { credentials: string; claudeJson: string };
const oauthOf = (snap: Snap | null): Rec | null => (snap && isRecord(snap.data.claudeAiOauth) ? snap.data.claudeAiOauth : null);
const expiry = (o: Rec | null): number => (typeof o?.expiresAt === 'number' ? o.expiresAt : 0);

const JOURNAL = 'swap-journal.json';
const BACKUP = { liveCreds: 'live-credentials.json', liveJson: 'live-claude.json', outCreds: 'outgoing-credentials.json', outJson: 'outgoing-claude.json' };
type Phase = 'backed-up' | 'outgoing-saved' | 'live-creds-written' | 'live-json-written' | 'verified';
const ORDER: readonly Phase[] = ['backed-up', 'outgoing-saved', 'live-creds-written', 'live-json-written', 'verified'];
/** The target is renewed first only when its access token runs out within this margin: a valid token is never rotated needlessly. */
export const TARGET_FRESH_MS = 5 * 60_000;
const MIN_VALID_MS = 60_000;
/** What the family gate answers for a profile it may not renew (never a real refresh outcome: compared by identity). */
const BLOCKED: RefreshOutcome = { kind: 'transient', detail: { reason: 'blocked' } };

interface Journal { version: 2; phase: Phase; outgoingId: string; targetId: string; created: boolean; outCredsExisted: boolean; outJsonExisted: boolean; startedAt: number }

class Fail extends Error {
  constructor(readonly code: SwapError, readonly email?: string) { super(code); }
}

/** An unreadable roster holds everything (conservative, like `readCswapRoster`). */
const rosterOf = (deps: Pick<ActivateDeps, 'cswap'>): Promise<CswapRoster> => deps.cswap().catch((): CswapRoster => ({ present: true, accounts: null }));

/**
 * Why `record` may not become the main login, or null. One rule with the renewals (`renewRule`): a record that is or may be
 * the live account is already main, and a family held elsewhere (switched out, or a copy cswap may hold) is refused,
 * because its tokens may be outdated and swapping them in could hand Claude Code a dead login.
 */
export function activationRefusal(record: ManagedAccount | undefined, live: AccountIdentity | null, roster: CswapRoster): { error: SwapError; email?: string } | null {
  const named = (error: SwapError) => ({ error, ...(record?.email ? { email: record.email } : {}) });
  if (!record || custodyOf(record) === 'quarantined') return named('noTarget');
  const rule = renewRule(record, live, roster);
  if (rule === 'allowed') return null;
  if (custodyOf(record) === 'live' || (rule === 'held-by-live' && live && compareIdentity(record, live) === 'same')) return named('sameAccount');
  return named('foreign');
}

/** The checks of the `accounts:makeMain` IPC handler: the renderer's choice is never trusted. */
export async function checkActivationTarget(deps: Pick<ActivateDeps, 'store' | 'cswap'>, targetId: string): Promise<SwapResult | null> {
  const refusal = activationRefusal(deps.store.get(targetId), deps.store.live(), await rosterOf(deps));
  return refusal ? { ok: false, ...refusal } : null;
}

export async function activateAccount(deps: ActivateDeps, targetId: string): Promise<SwapResult> {
  if (deps.platform === 'darwin') return { ok: false, error: 'unsupported' };
  if (!isAccountId(targetId)) return { ok: false, error: 'invalid' };
  if (!claimSwap()) return { ok: false, error: 'busy' };
  try {
    if (await hasPendingSwap(deps)) return { ok: false, error: 'pending' };
    return await perform(deps, deps.fs ?? nodeSwapFs, targetId);
  } catch (error) {
    if (error instanceof Fail) {
      if (error.code === 'manual') setSwapUnresolved(true);
      return { ok: false, error: error.code, ...(error.email ? { email: error.email } : {}) };
    }
    return { ok: false, error: error instanceof LockTimeout ? 'locked' : 'write' };
  } finally {
    releaseSwap();
  }
}

async function perform(deps: ActivateDeps, fs: SwapFs, targetId: string): Promise<SwapResult> {
  const { store } = deps;
  if (deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) throw new Fail('envToken');
  const paths = swapPaths(deps);
  if (!paths) throw new Fail('noMain');
  const target = store.get(targetId);
  const roster = await rosterOf(deps);
  const refusal = activationRefusal(target, store.live(), roster);
  if (refusal || !target) throw new Fail(refusal?.error ?? 'noTarget', refusal?.email);
  const dir = store.dirOf(targetId);
  const credsPath = join(dir, '.credentials.json');
  let snap = await readSnap(fs, credsPath);
  if (!validOauth(oauthOf(snap))) throw new Fail('noTarget', target.email);
  // Network only outside the locks, and only through the one family rule (the same gate the background renewals use).
  if (expiry(oauthOf(snap)) - deps.now() < TARGET_FRESH_MS) {
    const renew = gateFamilyRefresh(store, () => roster, (d) => deps.refresh(d), BLOCKED);
    let outcome: RefreshOutcome;
    try { outcome = await renew(dir); } catch { outcome = { kind: 'transient' }; }
    if (outcome === BLOCKED) throw new Fail('foreign', target.email);
    if (outcome.kind === 'dead' || outcome.kind === 'unusable') throw new Fail('dead', target.email);
    snap = await readSnap(fs, credsPath);
    if (!validOauth(oauthOf(snap))) throw new Fail('noTarget', target.email);
    if (outcome.kind === 'transient' && expiry(oauthOf(snap)) <= deps.now() + MIN_VALID_MS) throw new Fail('transient', target.email);
  }
  // The profile lock first: a background renewal of the target that is still in flight ends before Claude Code's locks are taken.
  return withProfileLock(dir, () => withClaudeLocks(paths, () => exchange(deps, fs, paths, roster, targetId, dir), deps.locks));
}

interface Originals { liveCreds: Snap; liveJson: Snap; liveAccount: Rec; outCreds: Snap | null; outJson: Snap | null; outDir: string }

async function exchange(deps: ActivateDeps, fs: SwapFs, paths: Paths, roster: CswapRoster, targetId: string, dir: string): Promise<SwapResult> {
  const { store } = deps;
  const liveCreds = await readSnap(fs, paths.credentials);
  const liveJson = await readSnap(fs, paths.claudeJson);
  const liveOauth = oauthOf(liveCreds);
  const liveAccount = liveJson && isRecord(liveJson.data.oauthAccount) ? liveJson.data.oauthAccount : null;
  const liveIdentity = identityFromOauthAccount(liveAccount);
  if (!liveCreds || !liveJson || !validOauth(liveOauth) || !liveAccount || (!liveIdentity.email && !liveIdentity.accountUuid)) throw new Fail('noMain');
  // Checked again under the locks against whoever is signed in right now (the stored live identity may lag behind).
  const target = store.get(targetId);
  const refusal = activationRefusal(target, liveIdentity, roster);
  if (refusal || !target) throw new Fail(refusal?.error ?? 'noTarget', refusal?.email);
  const targetOauth = oauthOf(await readSnap(fs, join(dir, '.credentials.json')));
  if (!validOauth(targetOauth)) throw new Fail('noTarget', target.email);
  const targetJson = await readSnap(fs, join(dir, '.claude.json'));
  const targetAccount: Rec = targetJson && isRecord(targetJson.data.oauthAccount) && str(targetJson.data.oauthAccount.emailAddress)
    ? targetJson.data.oauthAccount
    : { emailAddress: target.email, ...(target.org ? { organizationName: target.org } : {}), ...(target.accountUuid ? { accountUuid: target.accountUuid } : {}), ...(target.organizationUuid ? { organizationUuid: target.organizationUuid } : {}) };
  // The outgoing login goes into its own record (the one the app knows as live first); an account the app did not know
  // gets one, so a login is never dropped.
  const same = store.list().filter((r) => custodyOf(r) !== 'quarantined' && compareIdentity(r, liveIdentity) === 'same');
  const named = store.live()?.recordId;
  let outgoing = same.find((r) => r.id === named) ?? same.find((r) => custodyOf(r) === 'live') ?? same[0];
  const created = !outgoing;
  if (!outgoing) {
    const { id } = store.prepare();
    store.commit({ id, addedAt: deps.now(), ...identityFields(liveIdentity), custody: 'live', family: 'live' });
    outgoing = store.get(id)!;
  }
  const outDir = store.dirOf(outgoing.id);
  const outCreds = await readSnap(fs, join(outDir, '.credentials.json'));
  const outJson = await readSnap(fs, join(outDir, '.claude.json'));
  const journal: Journal = { version: 2, phase: 'backed-up', outgoingId: outgoing.id, targetId: target.id, created, outCredsExisted: !!outCreds, outJsonExisted: !!outJson, startedAt: deps.now() };
  const write = (path: string, data: string) => atomicWrite(deps, fs, path, data);
  // The phase is advanced BEFORE each step, so it says how far the swap may have got.
  const advance = async (phase: Phase) => { journal.phase = phase; await write(join(deps.backupDir, JOURNAL), JSON.stringify(journal)); };
  const writtenCreds = JSON.stringify({ ...liveCreds.data, claudeAiOauth: targetOauth });
  try {
    // Backups inside the try: a failure before the first journal write still removes them (no live file was touched yet).
    await fs.mkdir(deps.backupDir);
    await write(join(deps.backupDir, BACKUP.liveCreds), liveCreds.text);
    await write(join(deps.backupDir, BACKUP.liveJson), liveJson.text);
    if (outCreds) await write(join(deps.backupDir, BACKUP.outCreds), outCreds.text);
    if (outJson) await write(join(deps.backupDir, BACKUP.outJson), outJson.text);
    await advance('backed-up');
    await advance('outgoing-saved');
    await fs.mkdir(outDir);
    await write(join(outDir, '.credentials.json'), JSON.stringify({ ...(outCreds?.data ?? {}), claudeAiOauth: liveOauth }));
    await write(join(outDir, '.claude.json'), JSON.stringify({ ...(outJson?.data ?? {}), oauthAccount: liveAccount }, null, 2));
    await advance('live-creds-written');
    await write(paths.credentials, writtenCreds);
    await advance('live-json-written');
    const nowJson = await readSnap(fs, paths.claudeJson);
    await write(paths.claudeJson, JSON.stringify({ ...(nowJson?.data ?? liveJson.data), oauthAccount: targetAccount }, null, 2));
    // The locks keep Claude Code and cswap out, so the files must be exactly what was written.
    const vCreds = await readSnap(fs, paths.credentials);
    const vJson = await readSnap(fs, paths.claudeJson);
    if (vCreds?.text !== writtenCreds || !vJson || compareIdentity(identityFromOauthAccount(vJson.data.oauthAccount), identityFromOauthAccount(targetAccount)) !== 'same') throw new Fail('write');
    await advance('verified');
  } catch (error) {
    const clean = await rollback(deps, fs, paths, journal, { liveCreds, liveJson, liveAccount, outCreds, outJson, outDir });
    if (!clean) throw new Fail('manual');
    await removeBackups(deps, fs);
    if (created) store.remove(outgoing.id);
    throw error instanceof Fail ? error : new Fail('write');
  }
  finishRoles(store, outgoing.id, target.id, identityFromOauthAccount(targetAccount));
  try { await removeBackups(deps, fs); } catch { /* removed at the next start */ }
  return { ok: true, ...(str(targetAccount.emailAddress) ? { email: str(targetAccount.emailAddress) } : {}) };
}

/** The roles follow the files: the outgoing record now holds the only copy of its login (the live family), the target is live. */
function finishRoles(store: AccountsStore, outgoingId: string, targetId: string, identity: AccountIdentity): void {
  store.setCustody(outgoingId, 'app');
  store.setFamily(outgoingId, 'live');
  store.setCustody(targetId, 'live');
  store.setLive({ ...identityFields(identity), recordId: targetId });
}

/** Still under the locks: every step that may have started is undone from the backups taken in this run. */
async function rollback(deps: ActivateDeps, fs: SwapFs, paths: Paths, journal: Journal, o: Originals): Promise<boolean> {
  const reached = (phase: Phase) => ORDER.indexOf(journal.phase) >= ORDER.indexOf(phase);
  let clean = true;
  const step = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { clean = false; } };
  if (reached('live-creds-written')) await step(() => atomicWrite(deps, fs, paths.credentials, o.liveCreds.text));
  if (reached('live-json-written')) {
    await step(async () => {
      const now = await readSnap(fs, paths.claudeJson);
      await atomicWrite(deps, fs, paths.claudeJson, JSON.stringify({ ...(now?.data ?? o.liveJson.data), oauthAccount: o.liveAccount }, null, 2));
    });
  }
  if (reached('outgoing-saved')) {
    await step(() => (o.outCreds ? atomicWrite(deps, fs, join(o.outDir, '.credentials.json'), o.outCreds.text) : fs.rm(join(o.outDir, '.credentials.json'))));
    await step(() => (o.outJson ? atomicWrite(deps, fs, join(o.outDir, '.claude.json'), o.outJson.text) : fs.rm(join(o.outDir, '.claude.json'))));
  }
  return clean;
}

/** Temp files of the version-2 backups and journal (`<name>.<uuid>.tmp`); 0.9.0's files are left alone. */
const isV2Temp = (name: string) => [JOURNAL, ...Object.values(BACKUP)].some((base) => name.startsWith(`${base}.`) && /\.[0-9a-f-]{36}\.tmp$/.test(name));

async function removeBackups(deps: ActivateDeps, fs: SwapFs): Promise<void> {
  // The journal goes first: backups without a journal mean that no live file was modified.
  for (const name of [JOURNAL, ...Object.values(BACKUP)]) await fs.rm(join(deps.backupDir, name)).catch(() => undefined);
  for (const name of await fs.readdir(deps.backupDir)) if (isV2Temp(name)) await fs.rm(join(deps.backupDir, name)).catch(() => undefined);
  await fs.rmdir(deps.backupDir).catch(() => undefined);
}

/**
 * Call at app start, before the 0.9.0 recovery; 'legacy' means there is no version-2 journal and recoverInterruptedSwap
 * decides. Version-2 backups without any journal (a crash before the first journal write) are deleted first: no live file
 * was modified before that write.
 */
export async function recoverInterruptedActivation(deps: ActivateDeps): Promise<SwapRecovery | 'legacy'> {
  const fs = deps.fs ?? nodeSwapFs;
  let text: string | null;
  // An unreadable journal is not a missing one: nothing is deleted then.
  try { text = await fs.readFile(join(deps.backupDir, JOURNAL)); } catch { return 'legacy'; }
  if (text === null) {
    if (claimSwap()) {
      try {
        // Re-checked under the slot: only without a journal are the backups orphans.
        if ((await fs.readFile(join(deps.backupDir, JOURNAL))) === null) {
          for (const name of Object.values(BACKUP)) await fs.rm(join(deps.backupDir, name));
          for (const name of await fs.readdir(deps.backupDir)) if (isV2Temp(name)) await fs.rm(join(deps.backupDir, name));
          await fs.rmdir(deps.backupDir).catch(() => undefined);
        }
      } catch { /* the legacy recovery and the pending warning take over */ } finally { releaseSwap(); }
    }
    return 'legacy';
  }
  let info: unknown;
  try { info = JSON.parse(text); } catch { return 'legacy'; }
  if (!isRecord(info) || info.version !== 2) return 'legacy';
  if (!claimSwap()) return 'none';
  try {
    const result = await recoverV2(deps, fs, info);
    setSwapUnresolved(result === 'manual');
    return result;
  } catch {
    setSwapUnresolved(true);
    return 'manual';
  } finally {
    releaseSwap();
  }
}

async function recoverV2(deps: ActivateDeps, fs: SwapFs, info: Rec): Promise<SwapRecovery> {
  const { store } = deps;
  const phase = info.phase as Phase;
  const { outgoingId, targetId } = info;
  if (!ORDER.includes(phase) || !isAccountId(outgoingId) || !isAccountId(targetId)) return 'manual';
  if (phase === 'verified') {
    finishRoles(store, outgoingId, targetId, store.get(targetId) ?? {});
    await removeBackups(deps, fs);
    return 'none';
  }
  if (phase === 'backed-up') {
    await removeBackups(deps, fs);
    if (info.created === true) store.remove(outgoingId);
    return 'none';
  }
  const paths = swapPaths(deps);
  if (!paths) return 'manual';
  const read = (name: string) => fs.readFile(join(deps.backupDir, name));
  const liveB = await read(BACKUP.liveCreds);
  const liveJsonB = await read(BACKUP.liveJson);
  const outCredsB = await read(BACKUP.outCreds);
  const outJsonB = await read(BACKUP.outJson);
  if (liveB === null || liveJsonB === null) return 'manual';
  if ((info.outCredsExisted === true && outCredsB === null) || (info.outJsonExisted === true && outJsonB === null)) return 'manual';
  let liveAccountB: unknown;
  try { liveAccountB = (JSON.parse(liveJsonB) as Rec).oauthAccount; } catch { return 'manual'; }
  if (!isRecord(liveAccountB)) return 'manual';
  try {
    return await withClaudeLocks(paths, async (): Promise<SwapRecovery> => {
      const live = await readSnap(fs, paths.credentials);
      const targetCreds = await readSnap(fs, join(store.dirOf(targetId), '.credentials.json'));
      const untouched = live?.text === liveB;
      // Still exactly the target's login that was written (nobody renewed it since): the old one may go back.
      const liveRefresh = str(oauthOf(live)?.refreshToken);
      const ours = !!liveRefresh && liveRefresh === str(oauthOf(targetCreds)?.refreshToken);
      if (!untouched && !ours) return 'manual';
      if (!untouched) await atomicWrite(deps, fs, paths.credentials, liveB);
      const nowJson = await readSnap(fs, paths.claudeJson);
      if (nowJson && compareIdentity(identityFromOauthAccount(nowJson.data.oauthAccount), identityFromOauthAccount(liveAccountB)) !== 'same') {
        await atomicWrite(deps, fs, paths.claudeJson, JSON.stringify({ ...nowJson.data, oauthAccount: liveAccountB }, null, 2));
      }
      const outDir = store.dirOf(outgoingId);
      if (outCredsB !== null) await atomicWrite(deps, fs, join(outDir, '.credentials.json'), outCredsB); else await fs.rm(join(outDir, '.credentials.json'));
      if (outJsonB !== null) await atomicWrite(deps, fs, join(outDir, '.claude.json'), outJsonB); else await fs.rm(join(outDir, '.claude.json'));
      await removeBackups(deps, fs);
      if (info.created === true) store.remove(outgoingId);
      return 'recovered';
    }, deps.locks);
  } catch {
    return 'manual';
  }
}
