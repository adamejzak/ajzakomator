// One-time upgrade of the 0.9.0 accounts.json: identities from each profile's .claude.json, duplicates set aside (never
// deleted) and a notice for the panel. Which record is live is decided by reconcileLive on the first poll.
import { compareIdentity, custodyOf, fillMissingIdentity, identityFields, type AccountIdentity, type ManagedAccount } from '../../shared/accounts';
import { STORE_VERSION, type AccountsStore } from './store';

export interface MigrationDeps {
  store: AccountsStore;
  /** Identity in a profile's `.claude.json` (its `oauthAccount`). */
  readProfileIdentity(dir: string): Promise<AccountIdentity>;
  /** Identity of the live Claude Code login, or null when there is none. */
  readLiveIdentity(): Promise<AccountIdentity | null>;
  /** Access token expiry of a profile's login (the freshest of duplicates is kept). */
  readExpiry(dir: string): Promise<number | undefined>;
  now(): number;
}

export interface MigrationReport { migrated: boolean; filled: number; quarantined: Array<{ id: string; keptId: string }> }

export async function migrateAccounts(deps: MigrationDeps): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: false, filled: 0, quarantined: [] };
  const { store } = deps;
  if (store.version() >= STORE_VERSION) return report;
  for (const record of store.list()) {
    let found: AccountIdentity = {};
    try { found = identityFields(await deps.readProfileIdentity(store.dirOf(record.id))); } catch { /* no identity file */ }
    // The tokens belong to whoever the profile file names: a label that 0.9.0 rewrote ("Sign in again") follows the file,
    // and the old label's organisation goes with it.
    if (compareIdentity(record, found) === 'different') { store.updateIdentity(record.id, found, { replace: true }); report.filled++; continue; }
    const patch = fillMissingIdentity(record, found);
    if (Object.keys(patch).length) { store.updateIdentity(record.id, patch); report.filled++; }
  }
  let live: AccountIdentity | null = null;
  try { live = await deps.readLiveIdentity(); } catch { live = null; }
  const groups: ManagedAccount[][] = [];
  for (const record of store.list()) {
    if (custodyOf(record) === 'quarantined') continue;
    const group = groups.find((g) => compareIdentity(g[0], record) === 'same');
    if (group) group.push(record); else groups.push([record]);
  }
  for (const group of groups) {
    if (group.length < 2) continue;
    const keep = live && compareIdentity(live, group[0]) === 'same' ? oldest(group) : await freshest(group, deps);
    for (const record of group) {
      if (record.id === keep.id) continue;
      store.setCustody(record.id, 'quarantined', keep.id);
      store.addNotice({ kind: 'quarantined', at: deps.now(), recordId: record.id, ...(record.email ? { email: record.email } : {}) });
      report.quarantined.push({ id: record.id, keptId: keep.id });
    }
  }
  store.markMigrated();
  if (report.filled || report.quarantined.length) store.addNotice({ kind: 'migrated', at: deps.now(), count: report.filled + report.quarantined.length });
  report.migrated = true;
  return report;
}

const oldest = (group: ManagedAccount[]): ManagedAccount => [...group].sort((a, b) => a.addedAt - b.addedAt)[0];

async function freshest(group: ManagedAccount[], deps: MigrationDeps): Promise<ManagedAccount> {
  let best = group[0];
  let bestAt = -Infinity;
  for (const record of group) {
    let at: number | undefined;
    try { at = await deps.readExpiry(deps.store.dirOf(record.id)); } catch { at = undefined; }
    if ((at ?? -Infinity) > bestAt) { best = record; bestAt = at ?? -Infinity; }
  }
  return best;
}
