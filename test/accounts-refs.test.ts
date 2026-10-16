import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManagedAccount } from '../src/shared/accounts';
import { cswapHolds, cswapRosterPath, readCswapRoster } from '../src/main/accounts/cswap';
import { claudeRefs, renewRule } from '../src/main/accounts/refs';

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
});
