// Detects changes of the live Claude Code login made outside the app (cswap switch, `claude /login`, sign-out) on every poll
// and file change, and assigns the roles: the record holding the live identity becomes `live` (one card per account), the
// one that left becomes `foreign` (kept, never renewed) unless the app made the change itself, and a second record of the
// live account is set aside. Nothing is deleted. Callers hold the swap slot (claimSwap) so this never interleaves with an
// activation or a recovery.
import { compareIdentity, custodyOf, fillMissingIdentity, identityFields, type AccountIdentity, type LiveIdentity, type ManagedAccount } from '../../shared/accounts';
import type { ResyncResult } from './resync';
import { AccountsReadOnlyError, type AccountsStore } from './store';
import { claimSwap, releaseSwap } from './swap';

export interface ReconcileDeps {
  store: AccountsStore;
  /** Identity in the live Claude Code config (`oauthAccount` of `~/.claude.json`), null when nobody is signed in. */
  readLiveIdentity(): Promise<AccountIdentity | null>;
  /** Refreshes the active record's backup from the live login; absent where the live login is not a file (macOS Keychain). */
  resync?(recordId: string, identity: AccountIdentity): Promise<ResyncResult>;
  now(): number;
}

export interface ReconcileResult { activeId: string | null; changed: boolean }

export async function reconcileLive(deps: ReconcileDeps, opts: { ownChange?: boolean } = {}): Promise<ReconcileResult> {
  const { store } = deps;
  const unchanged = (): ReconcileResult => ({ activeId: store.live()?.recordId ?? null, changed: false });
  // accounts.json cannot be read safely: nothing is written (and no backup is made for a record that may not be listed).
  if (store.readOnly()) return unchanged();
  const at = deps.now();
  let live: AccountIdentity | null;
  try { live = await deps.readLiveIdentity(); } catch { return unchanged(); }
  if (live && !live.email && !live.accountUuid) live = null;
  let changed = false;
  try {
    const visible = () => store.list().filter((r) => custodyOf(r) !== 'quarantined');
    const current = live;
    // The record the app already knows as live wins over an older copy of the same account, then any `live` one.
    const named = store.live()?.recordId;
    const same = current ? visible().filter((r) => compareIdentity(r, current) === 'same') : [];
    let active: ManagedAccount | undefined = same.find((r) => r.id === named) ?? same.find((r) => custodyOf(r) === 'live') ?? same[0];
    if (current && !active) {
      // Signed in outside the app: the account becomes a record, so the main card is one account like any other.
      const { id } = store.prepare();
      store.commit({ id, addedAt: at, ...identityFields(current), custody: 'live', family: 'live' });
      store.addNotice({ kind: 'adopted', at, recordId: id, ...(current.email ? { email: current.email } : {}) });
      active = store.get(id);
      changed = true;
    }
    for (const record of visible()) {
      if (record.id === active?.id || custodyOf(record) !== 'live') continue;
      // A second record of the live account did not leave the login: it is set aside below, without a false notice. The test
      // is the very one the set-aside loop uses (against the holder), so a record is always either set aside or marked.
      if (active && current && compareIdentity(record, active) === 'same') continue;
      // It left the live login. Whoever switched it holds the newest tokens; ours may be consumed, so they are never renewed.
      store.setCustody(record.id, opts.ownChange ? 'app' : 'foreign');
      if (!opts.ownChange) store.addNotice({ kind: current ? 'switchedOut' : 'loggedOut', at, recordId: record.id, ...(record.email ? { email: record.email } : {}) });
      changed = true;
    }
    if (active && current) {
      const holder = active;
      for (const record of visible()) {
        if (record.id === holder.id || compareIdentity(record, holder) !== 'same') continue;
        store.setCustody(record.id, 'quarantined', holder.id);
        store.addNotice({ kind: 'quarantined', at, recordId: record.id, ...(record.email ? { email: record.email } : {}) });
        changed = true;
      }
      if (custodyOf(holder) !== 'live') { store.setCustody(holder.id, 'live'); changed = true; }
      const missing = fillMissingIdentity(holder, current);
      if (Object.keys(missing).length) { store.updateIdentity(holder.id, missing); changed = true; }
      if (deps.resync) { try { await deps.resync(holder.id, current); } catch { /* the next poll tries again */ } }
    }
    const next: LiveIdentity | null = current ? { ...identityFields(current), ...(active ? { recordId: active.id } : {}) } : null;
    if (JSON.stringify(store.live()) !== JSON.stringify(next)) { store.setLive(next); changed = true; }
    return { activeId: active?.id ?? null, changed };
  } catch (error) {
    // accounts.json became unreadable meanwhile: the writes stop here and the next poll starts over.
    if (error instanceof AccountsReadOnlyError) return { ...unchanged(), changed };
    throw error;
  }
}

/**
 * Runs `reconcile` holding the swap slot, so it never interleaves with an activation, a recovery or a re-login; skipped
 * (resolves false) while a swap runs or is unresolved or a login is in progress.
 */
export async function reconcileWhenIdle(
  guard: { swapUnresolved(): boolean; loginActive(): boolean; journalPending?(): Promise<boolean> },
  reconcile: () => Promise<unknown>,
): Promise<boolean> {
  if (guard.swapUnresolved() || guard.loginActive() || !claimSwap()) return false;
  try {
    // An interrupted activation's journal: the live files may be half written, so they are not read until it is recovered.
    if (guard.journalPending) {
      let pending = true;
      try { pending = await guard.journalPending(); } catch { /* unknown counts as pending */ }
      if (pending) return false;
    }
    await reconcile();
  } finally { releaseSwap(); }
  return true;
}

/** The live login could not be backed up (or not proven current); `reason` is the last resync result or `busy`. */
export class LiveBackupFailed extends Error {
  constructor(readonly reason: string) { super(`live login not backed up: ${reason}`); this.name = 'LiveBackupFailed'; }
}

/**
 * Before `claude auth login` replaces the live login (main re-login): reconciles holding the swap slot and resolves only
 * when the live login is backed up into its record - resync `copied` or `unchanged` - or there is nothing to back up
 * (nobody signed in, live credentials without a refresh token (`missing`), or no file login at all: no `resync`, macOS
 * Keychain). `settling` (not yet backed up), `locked`, `mismatch` and a failed copy are tried again `tries` times, then it
 * throws. A swap holding the slot, an unresolved swap or a pending activation journal refuse it too. The login being
 * started is the caller itself, so a login in progress does not count here. `ownChange`: an earlier login of the app
 * changed the live account and was not reconciled yet (see reconcileLive).
 */
export async function backupLiveBeforeLogin(
  guard: { swapUnresolved(): boolean; journalPending?(): Promise<boolean> },
  deps: ReconcileDeps,
  opts: { delay(ms: number): Promise<void>; tries?: number; gapMs?: number; ownChange?: boolean },
): Promise<void> {
  const tries = Math.max(1, opts.tries ?? 3);
  let reason = 'busy';
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await opts.delay(opts.gapMs ?? 1_000);
    const look: { live: 'unknown' | 'none' | 'present'; backup: ResyncResult | 'none' | 'failed' } = { live: 'unknown', backup: 'none' };
    const { resync } = deps;
    const watched: ReconcileDeps = {
      ...deps,
      readLiveIdentity: async () => {
        const identity = await deps.readLiveIdentity();
        look.live = identity && (identity.email || identity.accountUuid) ? 'present' : 'none';
        return identity;
      },
      ...(resync ? {
        resync: async (recordId: string, identity: AccountIdentity) => {
          look.backup = 'failed';
          look.backup = await resync(recordId, identity);
          return look.backup;
        },
      } : {}),
    };
    let ran = false;
    try {
      ran = await reconcileWhenIdle({ ...guard, loginActive: () => false }, () => reconcileLive(watched, opts.ownChange ? { ownChange: true } : {}));
    } catch { look.backup = 'failed'; }
    if (!ran) { reason = look.backup === 'failed' ? 'failed' : 'busy'; continue; }
    if (look.backup === 'copied' || look.backup === 'unchanged' || look.backup === 'missing') return;
    if (look.live === 'none' && look.backup === 'none') return;
    if (!resync && look.live === 'present') return;
    reason = look.backup === 'none' ? 'unread' : look.backup;
  }
  throw new LiveBackupFailed(reason);
}
