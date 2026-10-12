// src/main/accounts/makeMain.ts
import { isAccountId, type SwapResult } from '../../shared/accounts';

export interface MakeMainDeps {
  /** True while a login window flow (LoginManager) is in progress. */
  loginActive(): boolean;
  /** `swapMainAccount` bound to its real dependencies. */
  swap(id: string): Promise<SwapResult>;
  /** Called after a successful swap (refreshes the usage panel). */
  onSwapped(): void;
}

/**
 * IPC handler body for `accounts:makeMain`: validates the id, refuses while a login is in progress and reports the
 * outcome. The login side is guarded the other way round (LoginManager refuses to start during a swap).
 */
export async function handleMakeMain(deps: MakeMainDeps, id: unknown): Promise<SwapResult> {
  if (!isAccountId(id)) return { ok: false, error: 'invalid' };
  if (deps.loginActive()) return { ok: false, error: 'busy' };
  let result: SwapResult;
  try { result = await deps.swap(id); } catch { return { ok: false, error: 'write' }; }
  if (result.ok) {
    try { deps.onSwapped(); } catch { /* the usage panel refreshes on its own schedule */ }
  }
  return result;
}
