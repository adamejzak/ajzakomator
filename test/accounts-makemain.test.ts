// test/accounts-makemain.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SWAP_ERRORS, type SwapResult } from '../src/shared/accounts';
import { LANGUAGES } from '../src/shared/languages';
import { translate } from '../src/shared/i18n';
import { swapErrorKey, swapErrorText, swapMessages } from '../src/shared/swapMessages';
import { handleMakeMain, type MakeMainDeps } from '../src/main/accounts/makeMain';
import { LoginManager, type LoginDeps } from '../src/main/auth/login';
import type { AccountsStore } from '../src/main/accounts/store';

const ID = '123e4567-e89b-42d3-a456-426614174000';

function deps(over: Partial<MakeMainDeps> = {}) {
  const base = {
    loginActive: vi.fn(() => false),
    validate: vi.fn(async (): Promise<SwapResult | null> => null),
    swap: vi.fn(async (): Promise<SwapResult> => ({ ok: true, email: 'a@b.c' })),
    onSwapped: vi.fn(),
  };
  return { ...base, ...over } as typeof base & MakeMainDeps;
}

describe('accounts:makeMain handler', () => {
  it('rejects anything that is not an account id without touching the swap', async () => {
    const d = deps();
    for (const bad of [undefined, null, 5, '', '../x', 'main', { id: ID }, `${ID}/..`]) {
      expect(await handleMakeMain(d, bad)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(d.swap).not.toHaveBeenCalled();
    expect(d.onSwapped).not.toHaveBeenCalled();
  });

  it('refuses with busy while a login is in progress', async () => {
    const d = deps({ loginActive: vi.fn(() => true) });
    expect(await handleMakeMain(d, ID)).toEqual({ ok: false, error: 'busy' });
    expect(d.swap).not.toHaveBeenCalled();
  });

  it('validates the target in the main process and refuses without swapping', async () => {
    const refused = deps({ validate: vi.fn(async (): Promise<SwapResult | null> => ({ ok: false, error: 'foreign', email: 'x@x.com' })) });
    expect(await handleMakeMain(refused, ID)).toEqual({ ok: false, error: 'foreign', email: 'x@x.com' });
    expect(refused.validate).toHaveBeenCalledWith(ID);
    expect(refused.swap).not.toHaveBeenCalled();
    expect(refused.onSwapped).not.toHaveBeenCalled();
    const throwing = deps({ validate: vi.fn(async () => { throw new Error('x'); }) });
    expect(await handleMakeMain(throwing, ID)).toEqual({ ok: false, error: 'write' });
    expect(throwing.swap).not.toHaveBeenCalled();
  });

  it('refreshes usage only after a successful swap and passes the result through', async () => {
    const ok = deps();
    expect(await handleMakeMain(ok, ID)).toEqual({ ok: true, email: 'a@b.c' });
    expect(ok.swap).toHaveBeenCalledWith(ID);
    expect(ok.onSwapped).toHaveBeenCalledOnce();
    const failed = deps({ swap: vi.fn(async (): Promise<SwapResult> => ({ ok: false, error: 'dead' })) });
    expect(await handleMakeMain(failed, ID)).toEqual({ ok: false, error: 'dead' });
    expect(failed.onSwapped).not.toHaveBeenCalled();
  });

  it('turns a throwing swap into a write error and survives a throwing refresh', async () => {
    const boom = deps({ swap: vi.fn(async () => { throw new Error('secret-token'); }) });
    const res = await handleMakeMain(boom, ID);
    expect(res).toEqual({ ok: false, error: 'write' });
    expect(JSON.stringify(res)).not.toContain('secret-token');
    const badRefresh = deps({ onSwapped: vi.fn(() => { throw new Error('x'); }) });
    expect(await handleMakeMain(badRefresh, ID)).toEqual({ ok: true, email: 'a@b.c' });
  });
});

describe('LoginManager and swap cross-check', () => {
  const store = { list: () => [], dirOf: () => '', prepare: () => ({ id: ID, dir: '' }), remove: () => undefined } as unknown as AccountsStore;
  const login = (swapRunning: () => boolean) => {
    const loginDeps = {
      store, spawnPty: vi.fn(), killPty: vi.fn(), fingerprint: vi.fn(async () => null), identity: vi.fn(async () => ({})),
      knownIdentities: vi.fn(async () => []), snapshotProfile: vi.fn(async () => ({ credentials: null, claudeJson: null })),
      restoreProfile: vi.fn(async () => undefined), identityRewritten: vi.fn(async () => true), emit: vi.fn(), onChanged: vi.fn(), swapRunning, timeoutMs: 1000,
    } satisfies LoginDeps;
    return { manager: new LoginManager(loginDeps), loginDeps };
  };

  it('refuses to start a login while a swap runs', async () => {
    const { manager, loginDeps } = login(() => true);
    expect(await manager.start({ provider: 'codex', target: { type: 'main' } })).toEqual({ ok: false, error: 'busy' });
    expect(loginDeps.spawnPty).not.toHaveBeenCalled();
    expect(manager.isActive()).toBe(false);
  });

  it('reports an active login so the swap can refuse, and clears it on cancel', async () => {
    const { manager } = login(() => false);
    const res = await manager.start({ provider: 'codex', target: { type: 'main' } });
    if (!res.ok) throw new Error('unreachable');
    expect(manager.isActive()).toBe(true);
    expect(await handleMakeMain(deps({ loginActive: () => manager.isActive() }), ID)).toEqual({ ok: false, error: 'busy' });
    manager.cancel(res.sessionId);
    expect(manager.isActive()).toBe(false);
  });
});

describe('swap error messages', () => {
  it('maps every SwapError to a catalog message in all languages without leaking anything', () => {
    for (const error of SWAP_ERRORS) {
      const key = swapErrorKey(error);
      expect(Object.keys(swapMessages)).toContain(key);
      for (const { code } of LANGUAGES) expect(translate(code, key).trim().length, `${code}: ${error}`).toBeGreaterThan(0);
    }
  });

  it('falls back to the generic message for unknown values', () => {
    expect(swapErrorKey('nope')).toBe(swapErrorKey('invalid'));
    expect(swapErrorKey(undefined)).toBe(swapErrorKey('invalid'));
    expect(swapErrorKey('toString')).toBe(swapErrorKey('invalid'));
  });

  it('uses distinct messages for the specific errors', () => {
    const specific = SWAP_ERRORS.filter((e) => e !== 'invalid');
    expect(new Set(specific.map((e) => swapErrorKey(e))).size).toBe(specific.length);
  });

  it('names the account in the texts that concern one, and falls back to the plain text otherwise', () => {
    const named = swapErrorText({ error: 'foreign', email: 'x@x.com' });
    expect(named.params).toEqual({ email: 'x@x.com' });
    expect(translate('en', named.key, named.params)).toContain('x@x.com');
    for (const error of ['dead', 'transient', 'sameAccount', 'noTarget', 'duplicate', 'locked', 'manual'] as const) {
      const text = swapErrorText({ error, email: 'x@x.com' });
      for (const { code } of LANGUAGES) expect(translate(code, text.key, text.params), `${code}: ${error}`).toContain('x@x.com');
    }
    expect(swapErrorText({ error: 'foreign' })).toEqual({ key: swapErrorKey('foreign') });
    expect(swapErrorText({ error: 'busy', email: 'x@x.com' })).toEqual({ key: swapErrorKey('busy') });
    expect(swapErrorText({ error: 'nope', email: 'x@x.com' })).toEqual({ key: swapErrorKey('invalid') });
  });
});
