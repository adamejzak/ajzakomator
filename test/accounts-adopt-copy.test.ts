// "Renew this copy in unimux" (0.9.2): a saved copy cswap also lists becomes the app's own login on request.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CswapRoster } from '../src/main/accounts/cswap';
import { adoptCopyRefusal, gateFamilyRefresh, handleAdoptCopy, type AdoptCopyDeps } from '../src/main/accounts/guards';
import { renewRule } from '../src/main/accounts/refs';
import { AccountsStore } from '../src/main/accounts/store';
import { adoptCopyOffered, heldByOf, type ProviderUsage } from '../src/shared/usage';
import { cswapNoteText } from '../src/shared/usageMessages';
import { translate } from '../src/shared/i18n';
import { LANGUAGES } from '../src/shared/languages';

const LIVE = { email: 'main@x.com', accountUuid: 'u-main', organizationUuid: 'o-main' };
const COPY = { email: 'copy@x.com', accountUuid: 'u-copy', organizationUuid: 'o-copy' };
const ROSTER: CswapRoster = { present: true, accounts: [{ email: COPY.email, accountUuid: COPY.accountUuid }] };

let root: string;
let store: AccountsStore;
let copyId: string;

const deps = (over: Partial<AdoptCopyDeps> = {}): AdoptCopyDeps & { adopted: string[] } => {
  const adopted: string[] = [];
  return {
    swapRunning: () => false,
    swapPending: async () => false,
    loginActive: () => false,
    readOnly: () => store.readOnly(),
    get: (id) => store.get(id),
    live: () => store.live(),
    setFamily: (id, family) => store.setFamily(id, family),
    onAdopted: (id) => { adopted.push(id); },
    adopted,
    ...over,
  };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ajza-adopt-'));
  store = new AccountsStore(join(root, 'accounts'));
  // A 0.9.0 record (no custody, no family): app custody, live family.
  copyId = store.prepare().id;
  store.commit({ id: copyId, addedAt: 1, ...COPY });
  store.setLive(LIVE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('accounts:adoptCopy validation', () => {
  it('makes a held-by-cswap copy app-owned and reads its limits now', async () => {
    expect(renewRule(store.get(copyId)!, store.live(), ROSTER)).toBe('held-by-cswap');
    const d = deps();
    await expect(handleAdoptCopy(d, true, copyId)).resolves.toEqual({ ok: true });
    expect(store.get(copyId)?.family).toBe('own');
    expect(store.get(copyId)?.custody).toBeUndefined();
    expect(d.adopted).toEqual([copyId]);
  });

  it('refuses the live identity, also when only the e-mail tells it apart or the identity is unknown', async () => {
    store.setLive({ ...COPY });
    await expect(handleAdoptCopy(deps(), true, copyId)).resolves.toEqual({ ok: false, error: 'live' });
    store.setLive({ ...LIVE, recordId: copyId });
    await expect(handleAdoptCopy(deps(), true, copyId)).resolves.toEqual({ ok: false, error: 'live' });
    expect(adoptCopyRefusal({ id: copyId, addedAt: 1 }, LIVE)).toBe('live');
    expect(adoptCopyRefusal({ id: copyId, addedAt: 1, ...COPY }, null)).toBeNull();
    expect(store.get(copyId)?.family).toBeUndefined();
  });

  it('refuses a quarantined, foreign or live-custody record and an unknown or malformed id', async () => {
    for (const custody of ['quarantined', 'foreign', 'live'] as const) {
      store.setCustody(copyId, custody, custody === 'quarantined' ? store.prepare().id : undefined);
      const d = deps();
      await expect(handleAdoptCopy(d, true, copyId)).resolves.toEqual({ ok: false, error: 'invalid' });
      expect(store.get(copyId)?.family).toBeUndefined();
      expect(d.adopted).toEqual([]);
    }
    await expect(handleAdoptCopy(deps(), true, '99999999-9999-4999-8999-999999999999')).resolves.toEqual({ ok: false, error: 'invalid' });
    await expect(handleAdoptCopy(deps(), true, '../x')).resolves.toEqual({ ok: false, error: 'invalid' });
  });

  it('refuses a request that does not come from the app window', async () => {
    await expect(handleAdoptCopy(deps(), false, copyId)).resolves.toEqual({ ok: false, error: 'invalid' });
    expect(store.get(copyId)?.family).toBeUndefined();
  });

  it('refuses with readOnly while accounts.json cannot be read safely, and never writes it', async () => {
    const file = join(root, 'accounts', 'accounts.json');
    const body = JSON.stringify({ version: 99, claude: [{ id: copyId, addedAt: 1, ...COPY }] });
    writeFileSync(file, body);
    const d = deps();
    await expect(handleAdoptCopy(d, true, copyId)).resolves.toEqual({ ok: false, error: 'readOnly' });
    // A file that becomes read-only between the checks and the write: the store's refusal is the same fixed code.
    const write = deps({ readOnly: () => false, get: () => ({ id: copyId, addedAt: 1, ...COPY }) });
    await expect(handleAdoptCopy(write, true, copyId)).resolves.toEqual({ ok: false, error: 'readOnly' });
    expect(d.adopted).toEqual([]);
    expect(write.adopted).toEqual([]);
  });

  it('refuses while a swap runs or is unresolved', async () => {
    await expect(handleAdoptCopy(deps({ swapRunning: () => true }), true, copyId)).resolves.toEqual({ ok: false, error: 'busy' });
    await expect(handleAdoptCopy(deps({ swapPending: async () => true }), true, copyId)).resolves.toEqual({ ok: false, error: 'pending' });
    expect(store.get(copyId)?.family).toBeUndefined();
  });

  it('refuses with busy while a login window flow runs, before and after the wait', async () => {
    await expect(handleAdoptCopy(deps({ loginActive: () => true }), true, copyId)).resolves.toEqual({ ok: false, error: 'busy' });
    // A login that starts while the swap state is being read.
    let login = false;
    const d = deps({ loginActive: () => login, swapPending: async () => { login = true; return false; } });
    await expect(handleAdoptCopy(d, true, copyId)).resolves.toEqual({ ok: false, error: 'busy' });
    expect(store.get(copyId)?.family).toBeUndefined();
    expect(d.adopted).toEqual([]);
  });

  it('refuses with busy when a swap starts during the wait, right before the write', async () => {
    let swap = false;
    const d = deps({ swapRunning: () => swap, swapPending: async () => { swap = true; return false; } });
    await expect(handleAdoptCopy(d, true, copyId)).resolves.toEqual({ ok: false, error: 'busy' });
    expect(store.get(copyId)?.family).toBeUndefined();
    expect(d.adopted).toEqual([]);
  });

  it('reports a failed write with a fixed code and no message', async () => {
    const d = deps({ setFamily: () => { throw new Error('EACCES C:\\secret\\path'); } });
    await expect(handleAdoptCopy(d, true, copyId)).resolves.toEqual({ ok: false, error: 'write' });
  });
});

describe('after the copy is adopted', () => {
  it('renewRule allows it and gateFamilyRefresh lets the renewal run', async () => {
    const refresh = vi.fn(async (_dir: string) => 'renewed' as const);
    const gate = gateFamilyRefresh(store, () => ROSTER, refresh, 'blocked' as const);
    const dir = store.dirOf(copyId);
    mkdirSync(dir, { recursive: true });
    await expect(gate(dir)).resolves.toBe('blocked');
    expect(refresh).not.toHaveBeenCalled();
    await handleAdoptCopy(deps(), true, copyId);
    expect(renewRule(store.get(copyId)!, store.live(), ROSTER)).toBe('allowed');
    expect(heldByOf(renewRule(store.get(copyId)!, store.live(), ROSTER))).toBeUndefined();
    await expect(gate(dir)).resolves.toBe('renewed');
    expect(refresh).toHaveBeenCalledWith(dir);
  });
});

describe('adoptCopyOffered', () => {
  const card: Pick<ProviderUsage, 'provider' | 'managed' | 'active' | 'heldBy' | 'status'> = { provider: 'claude', managed: true, heldBy: 'cswap', status: 'ok' };
  it('offers the action only on a saved Claude card held by cswap', () => {
    expect(adoptCopyOffered(card)).toBe(true);
    expect(adoptCopyOffered({ ...card, status: 'elsewhere' })).toBe(true);
    expect(adoptCopyOffered({ ...card, status: 'expired' })).toBe(false);
    expect(adoptCopyOffered({ ...card, heldBy: undefined })).toBe(false);
    expect(adoptCopyOffered({ ...card, heldBy: 'live' })).toBe(false);
    expect(adoptCopyOffered({ ...card, heldBy: 'switched-out' })).toBe(false);
    expect(adoptCopyOffered({ ...card, active: true })).toBe(false);
    expect(adoptCopyOffered({ ...card, managed: false })).toBe(false);
    expect(adoptCopyOffered({ ...card, provider: 'codex' })).toBe(false);
  });
});

describe('cswapNoteText', () => {
  it('names the action in every held-by-cswap state but an expired sign-in, in every language', () => {
    for (const status of ['ok', 'error', 'dormant', 'elsewhere'] as const) {
      const key = cswapNoteText(status);
      expect(key, status).toBeDefined();
      for (const { code } of LANGUAGES) expect(translate(code, key!), `${code} ${status}`).toContain(translate(code, 'Odświeżaj tę kopię w unimuxie'));
    }
    // An access token that ran out: the text says so and does not promise that Make main account works.
    expect(cswapNoteText('elsewhere')).toContain('wygasł');
    expect(cswapNoteText('elsewhere')).not.toContain('Ustawienie jako główne');
    expect(cswapNoteText('ok')).toContain('Ustawienie jako główne');
    expect(cswapNoteText('expired')).toBeUndefined();
  });
});
