import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManagedAccount } from '../src/shared/accounts';
import { CSWAP_ROSTER_MAX_BYTES, cswapHolds, cswapRosterPath, readCswapRoster } from '../src/main/accounts/cswap';
import { accountsPanelInfo, claudeRefs, renewRule } from '../src/main/accounts/refs';

const ID = (n: number) => `${n}1111111-1111-4111-8111-111111111111`;
const rec = (n: number, over: Partial<ManagedAccount> = {}): ManagedAccount => ({ id: ID(n), addedAt: n, email: `u${n}@x.com`, accountUuid: `u${n}`, ...over });
const none = { present: false } as const;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ajza-refs-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('renewRule', () => {
  it('renews only app-held families that live nowhere else', () => {
    expect(renewRule(rec(1, { family: 'own' }), null, none)).toBe('allowed');
    expect(renewRule(rec(1, { custody: 'foreign' }), null, none)).toBe('switched-out');
    expect(renewRule(rec(1, { custody: 'live' }), null, none)).toBe('held-by-live');
    // P and main have the same identity but different refresh tokens: P is never renewed (investigation test 5).
    expect(renewRule(rec(1, { family: 'own' }), { email: 'u1@x.com', accountUuid: 'u1' }, none)).toBe('held-by-live');
    const roster = { present: true as const, accounts: [{ email: 'u1@x.com', accountUuid: 'u1' }] };
    expect(renewRule(rec(1), null, roster)).toBe('held-by-cswap');
    expect(renewRule(rec(1, { family: 'own' }), null, roster)).toBe('allowed');
    expect(renewRule(rec(1), null, { present: true, accounts: null })).toBe('held-by-cswap');
  });
  it('blocks a quarantined record and one whose identity cannot be told apart from the live login', () => {
    expect(renewRule(rec(1, { family: 'own', custody: 'quarantined' }), null, none)).not.toBe('allowed');
    const unknown: ManagedAccount = { id: ID(4), addedAt: 4, family: 'own' };
    expect(renewRule(unknown, { email: 'u2@x.com', accountUuid: 'u2' }, none)).toBe('held-by-live');
    expect(renewRule(unknown, null, none)).toBe('allowed');
    expect(renewRule(rec(1, { family: 'own' }), { email: 'u2@x.com', accountUuid: 'u2' }, none)).toBe('allowed');
  });
});

describe('claudeRefs', () => {
  it('lists the live record first with its identity key, then the others, never quarantined ones', () => {
    const records = [rec(1), rec(2, { custody: 'live' }), rec(3, { custody: 'quarantined' })];
    const refs = claudeRefs({ records, dirOf: (id) => `/d/${id}`, live: { email: 'u2@x.com', accountUuid: 'u2', recordId: ID(2) }, cswap: none, platform: 'win32' });
    expect(refs).toEqual([
      { id: `claude:${ID(2)}`, provider: 'claude', key: 'uuid:u2:-', active: true },
      { id: `claude:${ID(1)}`, provider: 'claude', configDir: `/d/${ID(1)}`, key: 'uuid:u1:-', renew: 'allowed' },
    ]);
  });
  it('keeps a signed-out placeholder when nobody is signed in, and no profiles on macOS', () => {
    expect(claudeRefs({ records: [], dirOf: (id) => id, live: null, cswap: none, platform: 'win32' })).toEqual([{ id: 'claude:main', provider: 'claude' }]);
    expect(claudeRefs({ records: [rec(1)], dirOf: (id) => id, live: null, cswap: none, platform: 'darwin' })).toEqual([{ id: 'claude:main', provider: 'claude' }]);
  });
});

describe('cswap roster (read only)', () => {
  it('finds the roster where cswap keeps it', () => {
    expect(cswapRosterPath('/h', {}, 'win32')).toBe(join('/h', '.claude-swap-backup', 'sequence.json'));
    expect(cswapRosterPath('/h', { XDG_DATA_HOME: '/x' }, 'linux')).toBe(join('/x', 'claude-swap', 'sequence.json'));
    expect(cswapRosterPath('/h', { XDG_DATA_HOME: 'rel' }, 'linux')).toBe(join('/h', '.local', 'share', 'claude-swap', 'sequence.json'));
    expect(cswapRosterPath('/h', { XDG_DATA_HOME: '~/data' }, 'linux')).toBe(join('/h', 'data', 'claude-swap', 'sequence.json'));
    expect(cswapRosterPath('/h', { XDG_DATA_HOME: '~' }, 'linux')).toBe(join('/h', 'claude-swap', 'sequence.json'));
  });
  it('reads identities only and treats an unreadable roster as holding everything', async () => {
    const path = cswapRosterPath(home, {}, 'win32');
    expect(await readCswapRoster(path)).toEqual({ present: false });
    mkdirSync(join(home, '.claude-swap-backup'));
    writeFileSync(path, JSON.stringify({ activeAccountNumber: 1, accounts: { 1: { email: 'a@x.com', uuid: 'ua', organizationUuid: '', organizationName: '', added: 'x' } } }));
    const roster = await readCswapRoster(path);
    expect(roster).toEqual({ present: true, accounts: [{ email: 'a@x.com', accountUuid: 'ua' }] });
    expect(cswapHolds(roster, { email: 'a@x.com', accountUuid: 'ua' })).toBe(true);
    expect(cswapHolds(roster, { email: 'b@x.com', accountUuid: 'ub' })).toBe(false);
    writeFileSync(path, '{ torn');
    expect(await readCswapRoster(path)).toEqual({ present: true, accounts: null });
  });
  it('holds everything for a roster it cannot trust and reads only usable entries', async () => {
    const path = cswapRosterPath(home, {}, 'win32');
    mkdirSync(path, { recursive: true }); // a directory where the file should be (EISDIR)
    expect(await readCswapRoster(path)).toEqual({ present: true, accounts: null });
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify({ accounts: [{ email: 'a@x.com', uuid: 'ua' }] }));
    expect(await readCswapRoster(path)).toEqual({ present: true, accounts: null });
    writeFileSync(path, JSON.stringify({ accounts: { 1: 'x', 2: null, 3: [1], 4: { email: 'tok@x.com', uuid: '', organizationUuid: '', organizationName: '', kind: 'api_key' } } }));
    const roster = await readCswapRoster(path);
    expect(roster).toEqual({ present: true, accounts: [{ email: 'tok@x.com' }] });
    // A token-added entry has no uuid: the e-mail decides.
    expect(cswapHolds(roster, { email: 'TOK@x.com', accountUuid: 'ut' })).toBe(true);
    expect(cswapHolds(roster, { email: 'other@x.com', accountUuid: 'uo' })).toBe(false);
    writeFileSync(path, JSON.stringify({ accounts: {}, pad: 'x'.repeat(CSWAP_ROSTER_MAX_BYTES) }));
    expect(await readCswapRoster(path)).toEqual({ present: true, accounts: null });
  });
});

describe('accountsPanelInfo', () => {
  it('lists set-aside cards (no holder, or parked) and the copies whose holder exists', () => {
    const records = [
      rec(1),
      rec(2, { custody: 'quarantined', duplicateOf: ID(1) }),
      rec(3, { custody: 'quarantined' }),
      rec(4, { custody: 'quarantined', duplicateOf: ID(9) }),
      rec(5, { custody: 'app' }),
    ];
    const info = accountsPanelInfo(records, [ID(5)]);
    expect(info.duplicateCopies).toEqual([ID(2)]);
    expect(info.setAside).toEqual([
      { recordId: ID(3), email: 'u3@x.com', restoring: false },
      { recordId: ID(4), email: 'u4@x.com', restoring: false },
      { recordId: ID(5), email: 'u5@x.com', restoring: true },
    ]);
  });

  it('a set-aside card signed in again (custody app) leaves the set-aside list', () => {
    expect(accountsPanelInfo([rec(3, { custody: 'app', family: 'own' })], []).setAside).toEqual([]);
  });
});
