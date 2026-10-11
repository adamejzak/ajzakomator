// test/usage-service.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchResult } from '../src/main/usage/fetchers';
import { MIN_GAP_MS, UsageService } from '../src/main/usage/service';
import { MAIN_ACCOUNTS, type AccountRef, type ProviderUsage, type UsageProvider } from '../src/shared/usage';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const ok = (provider: UsageProvider, percent: number, accountId = `${provider}:main`): FetchResult => ({
  usage: { accountId, provider, status: 'ok', plan: 'Max 5x', fetchedAt: Date.now(), source: 'live', windows: [{ id: '5h', usedPercent: percent, resetsAt: Math.floor(Date.now() / 1000) + 3600 }] },
});
const failing = (provider: UsageProvider, status: 'error' | 'expired', retryAfterMs?: number, accountId = `${provider}:main`): FetchResult => ({
  usage: { accountId, provider, status, fetchedAt: Date.now(), source: 'live', windows: [], ...(status === 'error' ? { error: 'http-500' } : {}) }, retryAfterMs,
});

let dir: string;
let cacheFile: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); dir = mkdtempSync(join(tmpdir(), 'ajza-usage-')); cacheFile = join(dir, 'usage-cache.json'); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function make(overrides: { claude?: () => Promise<FetchResult>; codex?: () => Promise<FetchResult>; enabled?: () => boolean; intervalMs?: () => number; accounts?: () => AccountRef[]; fetchAccount?: (ref: AccountRef) => Promise<FetchResult> } = {}) {
  const claude = vi.fn(overrides.claude ?? (async () => ok('claude', 40)));
  const codex = vi.fn(overrides.codex ?? (async () => ok('codex', 8)));
  const fetchAccount = vi.fn(overrides.fetchAccount ?? ((ref: AccountRef) => (ref.id === 'codex:main' ? codex() : claude())));
  const service = new UsageService({ accounts: overrides.accounts ?? (() => MAIN_ACCOUNTS), fetchAccount, cacheFile, enabled: overrides.enabled ?? (() => true), intervalMs: overrides.intervalMs ?? (() => 300_000) });
  return { service, claude, codex, fetchAccount };
}

describe('UsageService', () => {
  it('reads both providers at start, orders them and tells listeners', async () => {
    const { service, claude, codex } = make();
    const heard: ProviderUsage[][] = [];
    service.onChange((state) => heard.push(state.providers));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledOnce();
    expect(codex).toHaveBeenCalledOnce();
    expect(service.getState().providers.map((p) => [p.provider, p.windows[0].usedPercent])).toEqual([['claude', 40], ['codex', 8]]);
    expect(heard).toHaveLength(1);
    service.stop();
  });

  it('polls at the configured interval and stops when asked', async () => {
    const { service, claude } = make({ intervalMs: () => 60_000 });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claude).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claude).toHaveBeenCalledTimes(3);
    service.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(claude).toHaveBeenCalledTimes(3);
  });

  it('does nothing while disabled and resumes when enabled again', async () => {
    let enabled = false;
    const { service, claude } = make({ enabled: () => enabled });
    service.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(claude).not.toHaveBeenCalled();
    enabled = true;
    service.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledOnce();
    service.stop();
  });

  it('refreshes at most once per minimum gap and shares a request in flight', async () => {
    let release!: (value: FetchResult) => void;
    const { service, claude } = make({ claude: () => new Promise<FetchResult>((resolve) => { release = resolve; }) });
    const first = service.refresh();
    const second = service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    release(ok('claude', 10));
    await Promise.all([first, second]);
    await service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    claude.mockImplementation(async () => ok('claude', 11));
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it('keeps the last numbers when a read fails and backs off exponentially', async () => {
    let step = 0;
    const { service, claude } = make({ claude: async () => (step++ === 0 ? ok('claude', 55) : failing('claude', 'error')) });
    await service.refresh();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    const kept = service.getState().providers[0];
    expect(kept).toMatchObject({ status: 'error', error: 'http-500', source: 'cache' });
    expect(kept.windows[0].usedPercent).toBe(55);
    expect(claude).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After and clears the backoff after a success', async () => {
    let mode: 'limited' | 'fine' = 'limited';
    const { service, claude } = make({ claude: async () => (mode === 'limited' ? failing('claude', 'error', 300_000) : ok('claude', 20)) });
    await service.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    await service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    mode = 'fine';
    await vi.advanceTimersByTimeAsync(181_000);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(2);
    expect(service.getState().providers[0].status).toBe('ok');
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(claude).toHaveBeenCalledTimes(3);
  });

  it('keeps the numbers of an expired login and does not hammer the provider', async () => {
    let step = 0;
    const { service } = make({ codex: async () => (step++ === 0 ? ok('codex', 33) : failing('codex', 'expired')) });
    await service.refresh();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'expired', source: 'cache' });
    expect(service.getState().providers[1].windows[0].usedPercent).toBe(33);
  });

  it('survives a fetcher that throws', async () => {
    const { service } = make({ claude: async () => { throw new Error('unexpected'); } });
    await service.refresh();
    expect(service.getState().providers[0]).toMatchObject({ accountId: 'claude:main', provider: 'claude', status: 'error', error: 'network' });
  });

  it('remembers the last good result on disk and shows it as cached after a restart', async () => {
    const first = make();
    await first.service.refresh();
    expect(existsSync(cacheFile)).toBe(true);
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('SECRET-123');
    const second = make({ claude: () => new Promise<FetchResult>(() => undefined) });
    expect(second.service.getState().providers.map((p) => [p.provider, p.source, p.status])).toEqual([['claude', 'cache', 'ok'], ['codex', 'cache', 'ok']]);
  });

  it('never lets unknown fields from a fetcher reach state, listeners or the cache file', async () => {
    const rogue = async (): Promise<FetchResult> => ({ usage: { ...ok('claude', 40).usage, accessToken: 'SECRET-123' } as ProviderUsage });
    const { service } = make({ claude: rogue });
    const heard: string[] = [];
    service.onChange((state) => heard.push(JSON.stringify(state)));
    await service.refresh();
    expect(JSON.stringify(service.getState())).not.toContain('SECRET-123');
    expect(heard.join('')).not.toContain('SECRET-123');
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('SECRET-123');
    expect(service.getState().providers[0].windows[0].usedPercent).toBe(40);
  });

  it('loads a cache with garbage window entries and keeps only the valid ones', () => {
    writeFileSync(cacheFile, JSON.stringify({ providers: [
      null, 'x', { accountId: 'claude:main', provider: 'claude', status: 'error', source: 'live', fetchedAt: 5, token: 'SECRET-123', windows: [null, 7, { id: '5h', usedPercent: 'a', resetsAt: 1 }, { id: '9h', usedPercent: 1, resetsAt: 1 }, { id: '7d', usedPercent: 250, resetsAt: 10 }] },
      { accountId: 'codex:main', provider: 'codex', status: 'ok', source: 'live', fetchedAt: 5, windows: [null] },
    ] }));
    const providers = make().service.getState().providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ provider: 'claude', status: 'ok', source: 'cache', windows: [{ id: '7d', usedPercent: 100, resetsAt: 10 }] });
    expect(JSON.stringify(providers)).not.toContain('SECRET-123');
  });

  it('backs off after a failed read even when another source answered, and clears it on success', async () => {
    let mode: 'failed' | 'fine' = 'failed';
    const { service, codex } = make({ codex: async () => (mode === 'failed' ? { ...ok('codex', 30), usage: { ...ok('codex', 30).usage, source: 'log' as const }, failed: true as const, retryAfterMs: 300_000 } : ok('codex', 31)) });
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'ok', source: 'log' });
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(codex).toHaveBeenCalledOnce();
    mode = 'fine';
    await vi.advanceTimersByTimeAsync(300_000);
    await service.refresh();
    expect(codex).toHaveBeenCalledTimes(2);
    expect(service.getState().providers[1]).toMatchObject({ status: 'ok', source: 'live' });
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(codex).toHaveBeenCalledTimes(3);
  });

  it('lets a manual refresh bypass a backoff but not the minimum gap', async () => {
    const { service, claude } = make({ claude: async () => failing('claude', 'error', 600_000) });
    await service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    await service.refresh(true);
    expect(claude).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(claude).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh(true);
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it('replaces the entry when a login disappears and refreshes numbers when an expired login returns', async () => {
    let mode: 'ok' | 'out' | 'expired' | 'back' = 'ok';
    const out = (provider: UsageProvider): FetchResult => ({ usage: { accountId: `${provider}:main`, provider, status: 'signedOut', windows: [], fetchedAt: Date.now(), source: 'live' } });
    const { service } = make({ claude: async () => (mode === 'out' ? out('claude') : ok('claude', 40)), codex: async () => (mode === 'expired' ? failing('codex', 'expired') : mode === 'back' ? ok('codex', 12) : ok('codex', 8)) });
    await service.refresh();
    mode = 'out';
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[0]).toMatchObject({ status: 'signedOut', windows: [] });
    mode = 'expired';
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'expired', source: 'cache' });
    mode = 'back';
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'ok', source: 'live' });
    expect(service.getState().providers[1].windows[0].usedPercent).toBe(12);
  });

  it('stores an expired result that carries its own log windows as given and starts no backoff', async () => {
    let step = 0;
    const logWindows = [{ id: '5h' as const, usedPercent: 21, resetsAt: 1781010642 }];
    const { service, codex } = make({ codex: async () => (step++ === 0 ? ok('codex', 77) : { usage: { accountId: 'codex:main', provider: 'codex', status: 'expired', fetchedAt: 5, source: 'log', windows: logWindows } }) });
    await service.refresh();
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(service.getState().providers[1]).toMatchObject({ status: 'expired', source: 'log', fetchedAt: 5, windows: logWindows });
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
    await service.refresh();
    expect(codex).toHaveBeenCalledTimes(3);
  });

  it('ignores a corrupt cache file', () => {
    writeFileSync(cacheFile, '{broken');
    expect(make().service.getState().providers).toEqual([]);
  });

  it('pauses while inactive and catches up when active again with stale data', async () => {
    const { service, claude } = make({ intervalMs: () => 60_000 });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.setActive(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(claude).toHaveBeenCalledOnce();
    service.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledTimes(2);
    service.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(claude).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('applies a new interval after rescheduling', async () => {
    let interval = 600_000;
    const { service, claude } = make({ intervalMs: () => interval });
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    interval = 60_000;
    service.reschedule();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(claude).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('gives up on a read that never settles and keeps polling', async () => {
    let hang = true;
    const { service, claude } = make({ intervalMs: () => 60_000, claude: () => (hang ? new Promise<FetchResult>(() => undefined) : Promise.resolve(ok('claude', 12))) });
    service.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.getState().providers[0]).toMatchObject({ provider: 'claude', status: 'error', error: 'timeout' });
    hang = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(claude).toHaveBeenCalledTimes(2);
    expect(service.getState().providers[0].status).toBe('ok');
    service.stop();
  });

  it('is not disturbed by a listener that throws', async () => {
    const { service } = make();
    const heard: number[] = [];
    service.onChange(() => { throw new Error('bad listener'); });
    service.onChange((state) => heard.push(state.providers.length));
    await expect(service.refresh()).resolves.toBeDefined();
    expect(heard).toEqual([2]);
  });
  describe('accounts', () => {
    const extra: AccountRef = { id: 'claude:abc', provider: 'claude', configDir: '/profiles/abc' };

    it('polls every listed account and returns them in accounts() order', async () => {
      const list = [extra, ...MAIN_ACCOUNTS];
      const { service, fetchAccount } = make({ accounts: () => list, fetchAccount: async (ref) => ok(ref.provider, ref.id === 'claude:abc' ? 71 : 5, ref.id) });
      await service.refresh();
      expect(fetchAccount).toHaveBeenCalledTimes(3);
      expect(service.getState().providers.map((p) => [p.accountId, p.windows[0].usedPercent])).toEqual([['claude:abc', 71], ['claude:main', 5], ['codex:main', 5]]);
    });

    it('drops a removed account from state, the next cache write and a result still in flight', async () => {
      let list: AccountRef[] = [...MAIN_ACCOUNTS, extra];
      let release!: (value: FetchResult) => void;
      const slow = new Promise<FetchResult>((resolve) => { release = resolve; });
      let first = true;
      const { service } = make({ accounts: () => list, fetchAccount: (ref) => (ref.id === 'claude:abc' && !first ? slow : Promise.resolve(ok(ref.provider, 9, ref.id))) });
      await service.refresh();
      expect(service.getState().providers).toHaveLength(3);
      expect(readFileSync(cacheFile, 'utf8')).toContain('claude:abc');
      first = false;
      await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
      const run = service.refresh();
      list = MAIN_ACCOUNTS;
      expect(service.getState().providers.map((p) => p.accountId)).toEqual(['claude:main', 'codex:main']);
      release(ok('claude', 99, 'claude:abc'));
      await run;
      expect(service.getState().providers.map((p) => p.accountId)).toEqual(['claude:main', 'codex:main']);
      expect(readFileSync(cacheFile, 'utf8')).not.toContain('claude:abc');
    });

    it('shows a newly added account after the next refresh', async () => {
      let list: AccountRef[] = MAIN_ACCOUNTS;
      const { service } = make({ accounts: () => list, fetchAccount: async (ref) => ok(ref.provider, 9, ref.id) });
      await service.refresh();
      list = [...MAIN_ACCOUNTS, extra];
      expect(service.getState().providers).toHaveLength(2);
      await service.refresh(false, true);
      expect(service.getState().providers.map((p) => p.accountId)).toEqual(['claude:main', 'codex:main', 'claude:abc']);
    });

    it('ignores the minimum gap only when forced, and still shares a request in flight', async () => {
      const { service, claude } = make();
      await service.refresh();
      await service.refresh();
      expect(claude).toHaveBeenCalledOnce();
      await service.refresh(false, true);
      expect(claude).toHaveBeenCalledTimes(2);
      let release!: (value: FetchResult) => void;
      claude.mockImplementation(() => new Promise<FetchResult>((resolve) => { release = resolve; }));
      const a = service.refresh(false, true);
      const b = service.refresh(false, true);
      expect(claude).toHaveBeenCalledTimes(3);
      release(ok('claude', 1));
      await Promise.all([a, b]);
    });

    it('backs off per account id', async () => {
      const { service, fetchAccount } = make({ accounts: () => [extra, ...MAIN_ACCOUNTS], fetchAccount: async (ref) => (ref.id === 'claude:abc' ? failing('claude', 'error', 600_000, ref.id) : ok(ref.provider, 9, ref.id)) });
      await service.refresh();
      await vi.advanceTimersByTimeAsync(MIN_GAP_MS + 1);
      await service.refresh();
      const calls = (id: string) => fetchAccount.mock.calls.filter(([ref]) => ref.id === id).length;
      expect(calls('claude:abc')).toBe(1);
      expect(calls('claude:main')).toBe(2);
      expect(calls('codex:main')).toBe(2);
    });

    it('ignores cache entries from an older file without an account id', () => {
      writeFileSync(cacheFile, JSON.stringify({ providers: [{ provider: 'claude', status: 'ok', source: 'live', fetchedAt: 5, windows: [{ id: '5h', usedPercent: 3, resetsAt: 10 }] }] }));
      expect(make().service.getState().providers).toEqual([]);
    });
  });
});
