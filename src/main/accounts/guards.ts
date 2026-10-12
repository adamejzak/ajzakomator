// src/main/accounts/guards.ts
import { isAccountId, type SwapError } from '../../shared/accounts';

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
