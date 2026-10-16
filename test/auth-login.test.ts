// test/auth-login.test.ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginState } from '../src/shared/accounts';
import { AccountsStore } from '../src/main/accounts/store';
import { LoginManager, type LoginDeps } from '../src/main/auth/login';

const SECRET = 'fp-secret-123';
let base: string;
let store: AccountsStore;

beforeEach(() => {
  vi.useFakeTimers();
  base = mkdtempSync(join(tmpdir(), 'ajza-login-'));
  store = new AccountsStore(join(base, 'accounts'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(base, { recursive: true, force: true });
});

function setup(over: Partial<LoginDeps> = {}) {
  const states: LoginState[] = [];
  const fp: { value: string | null; calls: number } = { value: null, calls: 0 };
  const deps = {
    store,
    spawnPty: vi.fn(),
    killPty: vi.fn(),
    fingerprint: vi.fn(async () => { fp.calls++; return fp.value; }),
    identity: vi.fn(async () => ({ email: 'New@Example.com', org: 'Org' })),
    knownEmails: vi.fn(async () => [] as string[]),
    emit: vi.fn((state: LoginState) => { states.push(state); }),
    onChanged: vi.fn(),
  } satisfies LoginDeps;
  const merged = { ...deps, ...over } as LoginDeps;
  return { deps: merged, mock: deps, states, fp, manager: new LoginManager(merged) };
}

async function advance(ms: number) { await vi.advanceTimersByTimeAsync(ms); }

/** Starts a login, flips the fingerprint after the third poll and lets everything settle. */
async function runSuccess(h: ReturnType<typeof setup>, request: Parameters<LoginManager['start']>[0]) {
  const res = await h.manager.start(request);
  await advance(1500 * 2);
  h.fp.value = SECRET;
  await advance(1500 + 1500 + 10);
  return res;
}

const noSecret = (value: unknown) => expect(JSON.stringify(value)).not.toContain(SECRET);

describe('LoginManager', () => {
  it('rejects profile logins when profiles are unsupported but allows main logins', async () => {
    const h = setup({ profilesSupported: false });
    expect(await h.manager.start({ provider: 'claude', target: { type: 'new' } })).toEqual({ ok: false, error: 'unsupported' });
    expect(await h.manager.start({ provider: 'claude', target: { type: 'account', id: '123e4567-e89b-42d3-a456-426614174000' } })).toEqual({ ok: false, error: 'unsupported' });
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect((await h.manager.start({ provider: 'codex', target: { type: 'main' } })).ok).toBe(true);
  });

  it('failActive ends the session as failed, kills the pty and drops the pending profile', async () => {
    const h = setup();
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    if (!res.ok) throw new Error('unreachable');
    h.manager.failActive('spawn');
    expect(h.mock.killPty).toHaveBeenCalledWith(res.ptyId);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1].error).toBe('spawn');
    expect(store.list()).toEqual([]);
    h.manager.failActive('spawn');
    expect(h.states).toHaveLength(2);
  });

  it('registers a new Claude account after the fingerprint changes', async () => {
    const h = setup();
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.ptyId).toBe(`auth:${res.sessionId}`);
    await advance(1500 * 2);
    expect(h.mock.killPty).not.toHaveBeenCalled();
    h.fp.value = SECRET;
    await advance(1500);
    expect(h.mock.killPty).not.toHaveBeenCalled();
    await advance(1500 + 10);
    expect(h.mock.killPty).toHaveBeenCalledWith(res.ptyId);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(h.states[1].email).toBe('New@Example.com');
    const accounts = store.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe('New@Example.com');
    expect(accounts[0].org).toBe('Org');
    expect(accounts[0]).toMatchObject({ custody: 'app', family: 'own' });
    expect(h.mock.onChanged).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    noSecret(h.states); noSecret(res);
  });

  it('reports a duplicate e-mail and removes the profile', async () => {
    const h = setup({ knownEmails: vi.fn(async () => ['new@example.com']) });
    const res = await runSuccess(h, { provider: 'claude', target: { type: 'new' } });
    expect(res.ok).toBe(true);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'duplicate']);
    expect(h.states[1].email).toBe('New@Example.com');
    expect(store.list()).toEqual([]);
    expect(existsSync(join(base, 'accounts', 'claude'))).toBe(true);
    const spec = h.mock.spawnPty.mock.calls[0][0];
    expect(existsSync(spec.env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(h.mock.onChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails with identity when no e-mail shows up after retries', async () => {
    const h = setup({ identity: vi.fn(async () => ({})) });
    await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    h.fp.value = SECRET;
    await advance(1500 + 1500 + 10 + 5000);
    expect(h.deps.identity).toHaveBeenCalledTimes(5);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1].error).toBe('identity');
    expect(store.list()).toEqual([]);
    expect(existsSync(h.mock.spawnPty.mock.calls[0][0].env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries identity until an e-mail appears', async () => {
    let n = 0;
    const h = setup({ identity: vi.fn(async () => (++n < 3 ? {} : { email: 'late@example.com' })) });
    await runSuccess(h, { provider: 'claude', target: { type: 'new' } });
    await advance(3000);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.list()[0].email).toBe('late@example.com');
  });

  it('handles a Codex login', async () => {
    const h = setup();
    await runSuccess(h, { provider: 'codex', target: { type: 'main' } });
    expect(h.mock.spawnPty).toHaveBeenCalledWith({ id: expect.stringMatching(/^auth:/), env: {}, command: 'codex login' });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.list()).toEqual([]);
    expect(h.mock.onChanged).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-logs the main Claude login without touching the store', async () => {
    const h = setup();
    await runSuccess(h, { provider: 'claude', target: { type: 'main' } });
    expect(h.mock.spawnPty).toHaveBeenCalledWith({ id: expect.stringMatching(/^auth:/), env: {}, command: 'claude auth login --claudeai' });
    expect(h.deps.fingerprint).toHaveBeenCalledWith('claude', undefined);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.list()).toEqual([]);
    expect(h.mock.onChanged).toHaveBeenCalledTimes(1);
  });

  it('re-logs a managed account and updates its stored email', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'old@example.com', addedAt: 1 });
    const h = setup();
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.mock.spawnPty).toHaveBeenCalledWith({
      id: expect.stringMatching(/^auth:/),
      env: { CLAUDE_CONFIG_DIR: prepared.dir, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' },
      command: 'claude auth login --claudeai',
    });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'success']);
    expect(store.list()).toEqual([{ id: prepared.id, email: 'New@Example.com', org: 'Org', addedAt: 1, family: 'own' }]);
    expect(h.mock.onChanged).toHaveBeenCalledTimes(1);
    expect(existsSync(prepared.dir)).toBe(true);
  });

  it('times out, kills the pty and discards the pending profile', async () => {
    const h = setup();
    await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    const spec = h.mock.spawnPty.mock.calls[0][0];
    await advance(600000 + 10);
    expect(h.mock.killPty).toHaveBeenCalledWith(spec.id);
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1].error).toBe('timeout');
    expect(existsSync(spec.env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels mid-login without emitting anything more', async () => {
    const h = setup();
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    if (!res.ok) throw new Error('unreachable');
    const spec = h.mock.spawnPty.mock.calls[0][0];
    await advance(1500);
    h.manager.cancel(res.sessionId);
    expect(h.mock.killPty).toHaveBeenCalledWith(res.ptyId);
    expect(existsSync(spec.env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    h.fp.value = SECRET;
    await advance(700000);
    expect(h.states.map((s) => s.status)).toEqual(['waiting']);
    expect(store.list()).toEqual([]);
  });

  it('ignores cancel for an unknown session id', async () => {
    const h = setup();
    await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    h.manager.cancel('nope');
    expect(h.mock.killPty).not.toHaveBeenCalled();
    h.manager.dispose();
    expect(h.mock.killPty).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelling during the identity retries leaves no timers and no state', async () => {
    const h = setup({ identity: vi.fn(async () => ({})) });
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    if (!res.ok) throw new Error('unreachable');
    h.fp.value = SECRET;
    await advance(1500 + 1500 + 10 + 1500);
    h.manager.cancel(res.sessionId);
    expect(vi.getTimerCount()).toBe(0);
    await advance(10000);
    expect(h.states.map((s) => s.status)).toEqual(['waiting']);
    expect(store.list()).toEqual([]);
  });

  it('a second start cancels the first session', async () => {
    const h = setup();
    const first = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    const second = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(h.mock.killPty).toHaveBeenCalledWith(first.ptyId);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(existsSync(h.mock.spawnPty.mock.calls[0][0].env.CLAUDE_CONFIG_DIR)).toBe(false);
    h.manager.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid requests without spawning', async () => {
    const h = setup();
    const unknownId = '123e4567-e89b-42d3-a456-426614174000';
    const bad = [
      { provider: 'codex', target: { type: 'new' } },
      { provider: 'codex', target: { type: 'account', id: unknownId } },
      { provider: 'claude', target: { type: 'account', id: unknownId } },
      { provider: 'claude', target: { type: 'account', id: '../x' } },
      { provider: 'claude', target: { type: 'bogus' } },
      { provider: 'claude', target: 'main' },
      { provider: 'claude', target: null },
      { provider: 'gemini', target: { type: 'main' } },
      null,
    ];
    for (const request of bad) {
      expect(await h.manager.start(request as never)).toEqual({ ok: false, error: 'invalid request' });
    }
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports spawn failures and discards the pending profile', async () => {
    const spawnPty = vi.fn(() => { throw new Error('boom'); });
    const h = setup({ spawnPty });
    const res = await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    expect(res).toEqual({ ok: false, error: 'spawn' });
    expect(existsSync((spawnPty.mock.calls[0] as unknown as [{ env: Record<string, string> }])[0].env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(h.states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never leaks a fingerprint into states or return values', async () => {
    const h = setup();
    const res = await runSuccess(h, { provider: 'claude', target: { type: 'main' } });
    noSecret(res); noSecret(h.states);
    expect(h.deps.fingerprint).toHaveBeenCalled();
  });

  it('fails and cleans up when the store cannot commit, and a later start works', async () => {
    const failing = Object.create(store) as AccountsStore;
    failing.commit = () => { throw new Error('disk full'); };
    const h = setup({ store: failing });
    await runSuccess(h, { provider: 'claude', target: { type: 'new' } });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(h.states[1].error).toBe('identity');
    expect(existsSync(h.mock.spawnPty.mock.calls[0][0].env.CLAUDE_CONFIG_DIR)).toBe(false);
    expect(h.mock.onChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const again = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    expect(again.ok).toBe(true);
    h.manager.dispose();
  });

  it('fails the session when the store cannot update an account', async () => {
    const prepared = store.prepare();
    store.commit({ id: prepared.id, email: 'old@example.com', addedAt: 1 });
    const failing = Object.create(store) as AccountsStore;
    failing.update = () => { throw new Error('disk full'); };
    const h = setup({ store: failing });
    await runSuccess(h, { provider: 'claude', target: { type: 'account', id: prepared.id } });
    expect(h.states.map((s) => s.status)).toEqual(['waiting', 'failed']);
    expect(existsSync(prepared.dir)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns spawn when the profile cannot be prepared', async () => {
    const failing = Object.create(store) as AccountsStore;
    failing.prepare = () => { throw new Error('nope'); };
    const h = setup({ store: failing });
    expect(await h.manager.start({ provider: 'claude', target: { type: 'new' } })).toEqual({ ok: false, error: 'spawn' });
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the command and CLAUDE_CONFIG_DIR for a new account', async () => {
    const h = setup();
    await h.manager.start({ provider: 'claude', target: { type: 'new' } });
    const spec = h.mock.spawnPty.mock.calls[0][0];
    expect(spec.command).toBe('claude auth login --claudeai');
    expect(Object.keys(spec.env)).toEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(spec.env.ANTHROPIC_API_KEY).toBe('');
    expect(existsSync(spec.env.CLAUDE_CONFIG_DIR)).toBe(true);
    h.manager.dispose();
  });

  it('cancelling during the initial fingerprint read never spawns', async () => {
    let release: (value: string | null) => void = () => {};
    const h = setup({ fingerprint: vi.fn(() => new Promise<string | null>((resolve) => { release = resolve; })) });
    const pending = h.manager.start({ provider: 'claude', target: { type: 'new' } });
    h.manager.dispose();
    release(null);
    expect((await pending).ok).toBe(false);
    expect(h.mock.spawnPty).not.toHaveBeenCalled();
    expect(h.states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second start emits nothing for the first session', async () => {
    const h = setup();
    const first = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    const second = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    if (!first.ok || !second.ok) throw new Error('unreachable');
    h.fp.value = SECRET;
    await advance(1500 * 2 + 1500);
    expect(h.states.filter((s) => s.sessionId === first.sessionId).map((s) => s.status)).toEqual(['waiting']);
    expect(h.states.filter((s) => s.sessionId === second.sessionId).map((s) => s.status)).toEqual(['waiting', 'success']);
  });
});

describe('LoginManager on macOS (main login through the Keychain)', () => {
  it('starts a main Claude login without a config dir, resets the credential cache on start and every poll, and succeeds', async () => {
    let cached: string | null = null; // stands in for the 30 minute failure cache
    let keychain: string | null = null;
    const reset = vi.fn(() => { cached = null; });
    const h = setup({
      profilesSupported: false,
      resetCredentialCache: reset,
      fingerprint: vi.fn(async () => { cached = cached ?? keychain; return cached; }),
      identity: vi.fn(async () => ({ email: 'mac@example.com' })),
    });
    const res = await h.manager.start({ provider: 'claude', target: { type: 'main' } });
    expect(res.ok).toBe(true);
    expect(h.mock.spawnPty).toHaveBeenCalledWith({ id: expect.stringMatching(/^auth:/), env: {}, command: 'claude auth login --claudeai' });
    expect(reset).toHaveBeenCalledTimes(1);
    await advance(1500 * 2);
    keychain = SECRET;
    await advance(1500 + 1500 + 10);
    expect(reset.mock.calls.length).toBeGreaterThan(2);
    expect(h.states.at(-1)).toEqual({ sessionId: expect.any(String), status: 'success', email: 'mac@example.com' });
    expect(h.mock.onChanged).toHaveBeenCalledOnce();
  });
});
