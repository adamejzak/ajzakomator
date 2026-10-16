import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityFromOauthAccount, type AccountIdentity } from '../src/shared/accounts';
import { migrateAccounts, type MigrationDeps } from '../src/main/accounts/migrate';
import { AccountsStore } from '../src/main/accounts/store';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
let root: string;
let store: AccountsStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ajza-migrate-'));
  mkdirSync(join(root, 'accounts'), { recursive: true });
  store = new AccountsStore(join(root, 'accounts'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A 0.9.0 record (version-less accounts.json) with a fake login in its profile dir (never a real token). */
function legacy(id: string, addedAt: number, label: string, file: { email: string; uuid?: string; org?: string } | null, expiresAt = 1000) {
  const listed = store.list().map(({ id: i, addedAt: a, email }) => ({ id: i, addedAt: a, email }));
  writeFileSync(join(root, 'accounts', 'accounts.json'), JSON.stringify({ claude: [...listed, { id, addedAt, email: label }] }));
  const dir = store.dirOf(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `fake-access-${id}`, refreshToken: `fake-refresh-${id}`, expiresAt } }));
  if (file) writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: file.email, accountUuid: file.uuid, organizationUuid: file.org } }));
}
const deps = (live: AccountIdentity | null): MigrationDeps => ({
  store,
  readProfileIdentity: async (dir) => { try { return identityFromOauthAccount(JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')).oauthAccount); } catch { return {}; } },
  readLiveIdentity: async () => live,
  readExpiry: async (dir) => JSON.parse(await readFile(join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.expiresAt,
  now: () => 5,
});

describe('migrateAccounts (0.9.0 -> 0.9.1)', () => {
  it('backfills uuids from the profile and runs only once', async () => {
    legacy(A, 1, 'a@x.com', { email: 'a@x.com', uuid: 'ua', org: 'oa' });
    const report = await migrateAccounts(deps(null));
    expect(report).toMatchObject({ migrated: true, filled: 1, quarantined: [] });
    expect(store.get(A)).toMatchObject({ email: 'a@x.com', accountUuid: 'ua', organizationUuid: 'oa' });
    expect(store.version()).toBe(2);
    expect((await migrateAccounts(deps(null))).migrated).toBe(false);
  });

  it('sets duplicates of the live account aside, keeping the oldest record, deleting nothing', async () => {
    legacy(A, 1, 'a@x.com', { email: 'a@x.com', uuid: 'ua' });
    legacy(B, 2, 'a@x.com', { email: 'a@x.com', uuid: 'ua' });
    legacy(C, 3, 'c@x.com', { email: 'c@x.com', uuid: 'uc' });
    const report = await migrateAccounts(deps({ email: 'a@x.com', accountUuid: 'ua' }));
    expect(report.quarantined).toEqual([{ id: B, keptId: A }]);
    expect(store.get(B)).toMatchObject({ custody: 'quarantined', duplicateOf: A });
    expect(store.get(A)?.custody).toBeUndefined();
    for (const id of [A, B, C]) expect(existsSync(store.dirOf(id))).toBe(true);
    expect(store.notices().map((n) => n.kind).sort()).toEqual(['migrated', 'quarantined']);
  });

  it('keeps the freshest login of duplicates that are not live', async () => {
    legacy(A, 1, 'a@x.com', { email: 'a@x.com', uuid: 'ua' }, 100);
    legacy(B, 2, 'a@x.com', { email: 'a@x.com', uuid: 'ua' }, 900);
    const report = await migrateAccounts(deps({ email: 'z@x.com', accountUuid: 'uz' }));
    expect(report.quarantined).toEqual([{ id: A, keptId: B }]);
  });

  it('trusts the profile file over a label 0.9.0 rewrote', async () => {
    legacy(A, 1, 'support@guybot.xyz', { email: 'app@x.com', uuid: 'uapp' });
    await migrateAccounts(deps(null));
    expect(store.get(A)).toMatchObject({ email: 'app@x.com', accountUuid: 'uapp' });
  });

  it('drops a stale organisation of the rewritten label when the profile file names another account', async () => {
    legacy(A, 1, 'support@guybot.xyz', { email: 'app@x.com', uuid: 'uapp' });
    store.update(A, { org: 'Guybot' });
    await migrateAccounts(deps(null));
    expect(store.get(A)).toEqual({ id: A, addedAt: 1, email: 'app@x.com', accountUuid: 'uapp' });
  });
});
