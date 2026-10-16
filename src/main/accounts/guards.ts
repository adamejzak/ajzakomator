// src/main/accounts/guards.ts
import { custodyOf, isAccountId, type LiveIdentity, type ManagedAccount, type SwapError } from '../../shared/accounts';
import type { CswapRoster } from './cswap';
import { renewRule } from './refs';
import { AccountsReadOnlyError } from './store';

export interface GuardDeps {
  swapRunning(): boolean;
  /** True while a journal or backups of an unresolved swap exist. */
  swapPending(): Promise<boolean>;
  /** Synchronous view of the same fact (set the moment a swap leaves its backups behind). */
  swapPendingNow?(): boolean;
  /** accounts.json cannot be read safely (`AccountsStore.readOnly`): nothing about the saved accounts can be written. */
  readOnly?(): boolean;
}

/** Why account-changing actions must wait: a swap is running or an earlier one is unresolved. */
export async function accountMutationBlock(deps: GuardDeps): Promise<Extract<SwapError, 'busy' | 'pending'> | null> {
  if (deps.swapRunning()) return 'busy';
  try { if (await deps.swapPending()) return 'pending'; } catch { return 'pending'; }
  return null;
}

export interface RemoveDeps extends GuardDeps {
  /** True for the record signed in to Claude Code (custody `live` or the live identity's record): it is never removed. */
  isLive(id: string): boolean;
  cancelLogin(id: string): void;
  remove(id: string): void;
  onRemoved(): void;
}

/**
 * IPC handler body for `accounts:remove`; refused (in the main process) while a swap runs or is unresolved, with the
 * fixed code `readOnly` (never a thrown error) while accounts.json cannot be read safely, and with `live` for the record
 * signed in to Claude Code (the renderer's choice is never trusted: its profile is the backup of the live login).
 */
export async function handleRemoveAccount(deps: RemoveDeps, id: unknown): Promise<{ ok: boolean; error?: 'busy' | 'pending' | 'readOnly' | 'live' }> {
  if (!isAccountId(id)) return { ok: false };
  if (deps.readOnly?.()) return { ok: false, error: 'readOnly' };
  if (deps.isLive(id)) return { ok: false, error: 'live' };
  const block = await accountMutationBlock(deps);
  if (block) return { ok: false, error: block };
  // Checked again after the wait, right before a parked restore snapshot is dropped: the card must not stay without it.
  if (deps.readOnly?.()) return { ok: false, error: 'readOnly' };
  if (deps.isLive(id)) return { ok: false, error: 'live' };
  deps.cancelLogin(id);
  try {
    deps.remove(id);
  } catch (error) {
    if (error instanceof AccountsReadOnlyError) return { ok: false, error: 'readOnly' };
    throw error;
  }
  deps.onRemoved();
  return { ok: true };
}

/**
 * IPC handler body for `accounts:dismissNotice`: a read-only accounts.json keeps its notices (the panel explains that state);
 * any other failure becomes one fixed error (no path or system message reaches the renderer or the log).
 */
export function dismissAccountNotice(store: { dismissNotice(id: string): void }, id: unknown): void {
  if (typeof id !== 'string' || !id || id.length > 64) return;
  try {
    store.dismissNotice(id);
  } catch (error) {
    if (error instanceof AccountsReadOnlyError) return;
    throw new Error('notice not dismissed');
  }
}

/**
 * `auth:start` re-logins touch the files a swap moves (main login or a saved account), so they wait too. No Claude login
 * starts while accounts.json is read-only: its result could not be saved (and the main login could not be backed up).
 */
export async function loginBlock(deps: GuardDeps, request: unknown): Promise<'busy' | 'pending' | 'readOnly' | null> {
  const req = request as { provider?: unknown; target?: { type?: unknown } } | null;
  if (req?.provider !== 'claude') return null; // Codex logins never touch the files a swap moves
  if (deps.readOnly?.()) return 'readOnly';
  const target = req.target;
  if (target?.type !== 'main' && target?.type !== 'account') return null;
  return accountMutationBlock(deps);
}

/** Background refreshes must not write into a managed profile while a swap runs or is unresolved. */
export function gateProfileRefresh<R>(deps: GuardDeps, refresh: (dir: string) => Promise<R>, blocked: R): (dir: string) => Promise<R> {
  // Checked synchronously: nothing may happen between the check and the start of the refresh.
  return (dir) => (deps.swapRunning() || deps.swapPendingNow?.() ? Promise.resolve(blocked) : refresh(dir));
}

/**
 * Background renewals follow the one family rule of `renewRule` (R6), the same rule the limits cards show: a profile is
 * renewed only when its token family lives nowhere else - not the live login (`live` custody or the live identity), not a
 * record switched out by another tool (`foreign`), not a copy of the live family that cswap may hold too. A set-aside copy
 * (`quarantined`) and a dir no record names are never renewed either.
 */
export function gateFamilyRefresh<R>(
  store: { list(): ManagedAccount[]; dirOf(id: string): string; live(): LiveIdentity | null },
  cswap: () => CswapRoster,
  refresh: (dir: string) => Promise<R>,
  blocked: R,
): (dir: string) => Promise<R> {
  return (dir) => {
    const record = store.list().find((a) => store.dirOf(a.id) === dir);
    if (!record || custodyOf(record) === 'quarantined') return Promise.resolve(blocked);
    return renewRule(record, store.live(), cswap()) === 'allowed' ? refresh(dir) : Promise.resolve(blocked);
  };
}
