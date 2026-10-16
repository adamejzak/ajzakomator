// src/main/accounts/guards.ts
import { custodyOf, isAccountId, type LiveIdentity, type ManagedAccount, type SwapError } from '../../shared/accounts';
import type { CswapRoster } from './cswap';
import { renewRule } from './refs';

export interface GuardDeps {
  swapRunning(): boolean;
  /** True while a journal or backups of an unresolved swap exist. */
  swapPending(): Promise<boolean>;
  /** Synchronous view of the same fact (set the moment a swap leaves its backups behind). */
  swapPendingNow?(): boolean;
}

/** Why account-changing actions must wait: a swap is running or an earlier one is unresolved. */
export async function accountMutationBlock(deps: GuardDeps): Promise<Extract<SwapError, 'busy' | 'pending'> | null> {
  if (deps.swapRunning()) return 'busy';
  try { if (await deps.swapPending()) return 'pending'; } catch { return 'pending'; }
  return null;
}

export interface RemoveDeps extends GuardDeps {
  cancelLogin(id: string): void;
  remove(id: string): void;
  onRemoved(): void;
}

/** IPC handler body for `accounts:remove`; refused (in the main process) while a swap runs or is unresolved. */
export async function handleRemoveAccount(deps: RemoveDeps, id: unknown): Promise<{ ok: boolean; error?: 'busy' | 'pending' }> {
  if (!isAccountId(id)) return { ok: false };
  const block = await accountMutationBlock(deps);
  if (block) return { ok: false, error: block };
  deps.cancelLogin(id);
  deps.remove(id);
  deps.onRemoved();
  return { ok: true };
}

/** `auth:start` re-logins touch the files a swap moves (main login or a saved account), so they wait too. */
export async function loginBlock(deps: GuardDeps, request: unknown): Promise<'busy' | 'pending' | null> {
  const req = request as { provider?: unknown; target?: { type?: unknown } } | null;
  if (req?.provider !== 'claude') return null; // Codex logins never touch the files a swap moves
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
