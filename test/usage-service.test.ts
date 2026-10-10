// test/usage-service.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchResult } from '../src/main/usage/fetchers';
import { MIN_GAP_MS, UsageService } from '../src/main/usage/service';
import type { ProviderUsage, UsageProvider } from '../src/shared/usage';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const ok = (provider: UsageProvider, percent: number): FetchResult => ({
  usage: { provider, status: 'ok', plan: 'Max 5x', fetchedAt: Date.now(), source: 'live', windows: [{ id: '5h', usedPercent: percent, resetsAt: Math.floor(Date.now() / 1000) + 3600 }] },
});
const failing = (provider: UsageProvider, status: 'error' | 'expired', retryAfterMs?: number): FetchResult => ({
  usage: { provider, status, fetchedAt: Date.now(), source: 'live', windows: [], ...(status === 'error' ? { error: 'http-500' } : {}) }, retryAfterMs,
});

let dir: string;
let cacheFile: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); dir = mkdtempSync(join(tmpdir(), 'ajza-usage-')); cacheFile = join(dir, 'usage-cache.json'); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function make(overrides: { claude?: () => Promise<FetchResult>; codex?: () => Promise<FetchResult>; enabled?: () => boolean; intervalMs?: () => number } = {}) {
  const claude = vi.fn(overrides.claude ?? (async () => ok('claude', 40)));
  const codex = vi.fn(overrides.codex ?? (async () => ok('codex', 8)));
  const service = new UsageService({ fetchers: { claude, codex }, cacheFile, enabled: overrides.enabled ?? (() => true), intervalMs: overrides.intervalMs ?? (() => 300_000) });
  return { service, claude, codex };
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
    expect(service.getState().providers[0]).toMatchObject({ provider: 'claude', status: 'error', error: 'network' });
  });

  it('remembers the last good result on disk and shows it as cached after a restart', async () => {
    const first = make();
    await first.service.refresh();
    expect(existsSync(cacheFile)).toBe(true);
    expect(readFileSync(cacheFile, 'utf8')).not.toMatch(/token/i);
    const second = make({ claude: () => new Promise<FetchResult>(() => undefined) });
    expect(second.service.getState().providers.map((p) => [p.provider, p.source, p.status])).toEqual([['claude', 'cache', 'ok'], ['codex', 'cache', 'ok']]);
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
});
