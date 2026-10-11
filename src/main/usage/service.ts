// src/main/usage/service.ts
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { AccountRef, ProviderUsage, UsageState } from '../../shared/usage';
import type { FetchResult } from './fetchers';
import { sanitizeUsage } from './sanitize';

export const MIN_GAP_MS = 20_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface UsageServiceOptions {
  /** The accounts to poll right now; read on every run and every state read, so changes apply without a restart. */
  accounts(): AccountRef[];
  fetchAccount(ref: AccountRef): Promise<FetchResult>;
  /** Where the last good result is remembered (no credentials are stored there). */
  cacheFile: string;
  enabled(): boolean;
  /** Polling interval in milliseconds; 0 or less disables polling. */
  intervalMs(): number;
  now?(): number;
}

/** Owns the provider state: polling, minimum gap between reads, backoff after failures, on-disk cache. */
export class UsageService {
  private readonly providers = new Map<string, ProviderUsage>();
  private readonly listeners = new Set<(state: UsageState) => void>();
  private readonly backoff = new Map<string, { until: number; failures: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<UsageState> | undefined;
  private followUp: Promise<UsageState> | undefined;
  private lastRun = 0;
  private running = false;
  private active = true;
  private readonly now: () => number;

  constructor(private readonly options: UsageServiceOptions) {
    this.now = options.now ?? Date.now;
    this.loadCache();
  }

  getState(): UsageState {
    return { providers: this.options.accounts().flatMap((ref) => { const usage = this.providers.get(ref.id); return usage ? [usage] : []; }) };
  }

  onChange(listener: (state: UsageState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    this.running = true;
    void this.kick();
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
    if (this.running && this.options.enabled() && interval > 0 && this.now() - this.lastRun >= interval) void this.kick();
    this.schedule();
  }

  /** Call after the enabled flag or the interval changed. */
  reschedule(): void {
    if (this.running && this.options.enabled()) void this.kick();
    this.schedule();
  }

  /** A manual refresh also reads accounts that are in backoff; `force` also skips the minimum gap. The shared request still applies. */
  refresh(manual = false, force = false): Promise<UsageState> {
    if (!this.options.enabled()) return Promise.resolve(this.getState());
    if (this.pending) {
      if (!force) return this.pending;
      // A forced caller (a new account was added) needs a run that starts after the current one; all share one follow-up.
      if (!this.followUp) {
        this.followUp = this.pending.catch(() => undefined).then(() => {
          this.followUp = undefined;
          return this.refresh(true, true);
        });
      }
      return this.followUp;
    }
    if (!force && this.lastRun && this.now() - this.lastRun < MIN_GAP_MS) return Promise.resolve(this.getState());
    this.pending = this.run(manual).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** Fire-and-forget refresh that can never reject. */
  private kick(): Promise<void> {
    return this.refresh().then(() => undefined, () => undefined);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.clearTimer();
    const interval = this.options.intervalMs();
    if (!this.running || !this.active || !this.options.enabled() || interval <= 0) return;
    this.timer = setTimeout(() => { void this.kick().then(() => this.schedule()); }, interval);
    this.timer.unref?.();
  }

  private async run(manual: boolean): Promise<UsageState> {
    const started = this.now();
    this.lastRun = started;
    const accounts = this.options.accounts();
    this.prune(accounts);
    await Promise.all(accounts.map((ref) => this.update(ref, started, manual)));
    this.prune(this.options.accounts());
    this.saveCache();
    const state = this.getState();
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* a bad listener must not affect the others or the run */ }
    }
    return state;
  }

  /** Forgets everything about accounts that are no longer listed. */
  private prune(accounts: AccountRef[]): void {
    const ids = new Set(accounts.map((ref) => ref.id));
    for (const id of [...this.providers.keys()]) if (!ids.has(id)) this.providers.delete(id);
    for (const id of [...this.backoff.keys()]) if (!ids.has(id)) this.backoff.delete(id);
  }

  private async update(ref: AccountRef, now: number, manual: boolean): Promise<void> {
    const { id, provider } = ref;
    const hold = this.backoff.get(id);
    if (!manual && hold && hold.until > now) return;
    let result: FetchResult;
    const failure = (error: string): FetchResult => ({ usage: { accountId: id, provider, status: 'error', windows: [], fetchedAt: now, source: 'live', error } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<FetchResult>((resolve) => { timeout = setTimeout(() => resolve(failure('timeout')), FETCH_TIMEOUT_MS); });
      result = await Promise.race([this.options.fetchAccount(ref), timedOut]);
    } catch { result = failure('network'); }
    finally { clearTimeout(timeout); }
    // A result for an account removed while it was in flight is dropped.
    if (!this.options.accounts().some((listed) => listed.id === id)) return;
    const parsed = sanitizeUsage(result.usage);
    const usage = parsed && parsed.accountId === id ? parsed : failure('bad-response').usage;
    const { retryAfterMs } = result;
    const failed = usage.status === 'error' || result.failed === true;
    if (usage.status === 'ok' || usage.status === 'signedOut' || usage.status === 'apiKey') {
      this.providers.set(id, usage);
      if (failed) this.startBackoff(id, now, hold?.failures, retryAfterMs);
      else this.backoff.delete(id);
      return;
    }
    // Expired or failed: keep the last numbers, marked as remembered, so the panel is never blank after a hiccup.
    const previous = this.providers.get(id);
    const own = usage.windows.length > 0;
    this.providers.set(id, !own && previous?.windows.length ? { ...usage, windows: previous.windows, fetchedAt: previous.fetchedAt, source: 'cache' } : usage);
    if (failed) this.startBackoff(id, now, hold?.failures, retryAfterMs);
    else this.backoff.delete(id);
  }

  private startBackoff(id: string, now: number, previousFailures = 0, retryAfterMs?: number): void {
    const failures = previousFailures + 1;
    const wait = retryAfterMs ?? Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    this.backoff.set(id, { until: now + wait, failures });
  }

  private loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(this.options.cacheFile, 'utf8')) as { providers?: unknown };
      for (const entry of Array.isArray(raw?.providers) ? raw.providers : []) {
        const usage = sanitizeUsage(entry);
        if (usage?.windows.length) this.providers.set(usage.accountId, { ...usage, status: 'ok', source: 'cache' });
      }
    } catch { /* no usable cache yet */ }
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.options.cacheFile), { recursive: true });
      writeFileSync(this.options.cacheFile, JSON.stringify({ providers: this.options.accounts().flatMap((ref) => { const usage = this.providers.get(ref.id); return usage?.windows.length ? [usage] : []; }) }));
    } catch { /* the cache is optional */ }
  }
}
