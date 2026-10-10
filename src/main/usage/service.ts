// src/main/usage/service.ts
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { ProviderUsage, UsageProvider, UsageState } from '../../shared/usage';
import type { FetchResult } from './fetchers';

export const MIN_GAP_MS = 20_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const ORDER: UsageProvider[] = ['claude', 'codex'];

export interface UsageServiceOptions {
  fetchers: Record<UsageProvider, () => Promise<FetchResult>>;
  /** Where the last good result is remembered (no credentials are stored there). */
  cacheFile: string;
  enabled(): boolean;
  /** Polling interval in milliseconds; 0 or less disables polling. */
  intervalMs(): number;
  now?(): number;
}

/** Owns the provider state: polling, minimum gap between reads, backoff after failures, on-disk cache. */
export class UsageService {
  private readonly providers = new Map<UsageProvider, ProviderUsage>();
  private readonly listeners = new Set<(state: UsageState) => void>();
  private readonly backoff = new Map<UsageProvider, { until: number; failures: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<UsageState> | undefined;
  private lastRun = 0;
  private running = false;
  private active = true;
  private readonly now: () => number;

  constructor(private readonly options: UsageServiceOptions) {
    this.now = options.now ?? Date.now;
    this.loadCache();
  }

  getState(): UsageState {
    return { providers: ORDER.flatMap((provider) => { const usage = this.providers.get(provider); return usage ? [usage] : []; }) };
  }

  onChange(listener: (state: UsageState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    this.running = true;
    void this.refresh();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /** The window was hidden or shown: no polling while hidden, a catch-up read on return when data is stale. */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) { this.clearTimer(); return; }
    const interval = this.options.intervalMs();
    if (this.running && this.options.enabled() && interval > 0 && this.now() - this.lastRun >= interval) void this.refresh();
    this.schedule();
  }

  /** Call after the enabled flag or the interval changed. */
  reschedule(): void {
    if (this.running && this.options.enabled()) void this.refresh();
    this.schedule();
  }

  refresh(): Promise<UsageState> {
    if (!this.options.enabled()) return Promise.resolve(this.getState());
    if (this.pending) return this.pending;
    if (this.lastRun && this.now() - this.lastRun < MIN_GAP_MS) return Promise.resolve(this.getState());
    this.pending = this.run().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.clearTimer();
    const interval = this.options.intervalMs();
    if (!this.running || !this.active || !this.options.enabled() || interval <= 0) return;
    this.timer = setTimeout(() => { void this.refresh().finally(() => this.schedule()); }, interval);
    this.timer.unref?.();
  }

  private async run(): Promise<UsageState> {
    const started = this.now();
    this.lastRun = started;
    await Promise.all(ORDER.map((provider) => this.update(provider, started)));
    this.saveCache();
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
    return state;
  }

  private async update(provider: UsageProvider, now: number): Promise<void> {
    const hold = this.backoff.get(provider);
    if (hold && hold.until > now) return;
    let result: FetchResult;
    try { result = await this.options.fetchers[provider](); }
    catch { result = { usage: { provider, status: 'error', windows: [], fetchedAt: now, source: 'live', error: 'network' } }; }
    const { usage, retryAfterMs } = result;
    if (usage.status === 'ok' || usage.status === 'signedOut' || usage.status === 'apiKey') {
      this.providers.set(provider, usage);
      this.backoff.delete(provider);
      return;
    }
    // Expired or failed: keep the last numbers, marked as remembered, so the panel is never blank after a hiccup.
    const previous = this.providers.get(provider);
    this.providers.set(provider, previous?.windows.length ? { ...usage, windows: previous.windows, fetchedAt: previous.fetchedAt, source: 'cache' } : usage);
    if (usage.status === 'error') {
      const failures = (hold?.failures ?? 0) + 1;
      const wait = retryAfterMs ?? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
      this.backoff.set(provider, { until: now + wait, failures });
    } else this.backoff.delete(provider);
  }

  private loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(this.options.cacheFile, 'utf8')) as { providers?: ProviderUsage[] };
      for (const usage of raw.providers ?? []) {
        if (usage && ORDER.includes(usage.provider) && Array.isArray(usage.windows) && usage.windows.length) this.providers.set(usage.provider, { ...usage, status: 'ok', source: 'cache' });
      }
    } catch { /* no usable cache yet */ }
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.options.cacheFile), { recursive: true });
      writeFileSync(this.options.cacheFile, JSON.stringify({ providers: [...this.providers.values()].filter((usage) => usage.windows.length) }));
    } catch { /* the cache is optional */ }
  }
}
