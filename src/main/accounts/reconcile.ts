// Detects changes of the live Claude Code login made outside the app (cswap switch, `claude /login`, sign-out) on every poll
// and file change, and assigns the roles: the record holding the live identity becomes `live` (one card per account), the
// one that left becomes `foreign` (kept, never renewed) unless the app made the change itself, and a second record of the
// live account is set aside. Nothing is deleted. Callers hold the swap slot (claimSwap) so this never interleaves with an
// activation or a recovery.
import { compareIdentity, custodyOf, fillMissingIdentity, identityFields, type AccountIdentity, type LiveIdentity, type ManagedAccount } from '../../shared/accounts';
import type { ResyncResult } from './resync';
import { AccountsReadOnlyError, type AccountsStore } from './store';

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
