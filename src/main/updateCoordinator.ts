/**
 * The one owner of "which version is being updated to". Free of Electron imports: the feed lookup and the download
 * are injected, so every race (a newer release appearing while an older one is offered, downloading, ready or being
 * installed) can be tested without an app.
 *
 * Rules:
 * - The target is whatever the newest feed answer says. A different answer supersedes the target: the running
 *   download is cancelled, a downloaded copy of the old version is forgotten and every listener is told.
 * - Once the hand-over to the installer started (`lockHandover`) nothing changes the state any more: a newer version
 *   is only remembered (`newerVersion`) and offered by the normal flow after the relaunch.
 * - One download per target; later callers join it. A download of a superseded version rejects with `SupersededError`.
 */
import type { UpdateState } from '../shared/types';

export interface Progress { percent: number; transferred?: number; total?: number; bytesPerSecond?: number }

/** An update the feed announces. `manual` means this app cannot install it by itself (portable build, macOS app that cannot replace itself). */
export interface FoundUpdate { version: string; manual?: { message?: string } }
export interface LookupResult { latest?: string; update?: FoundUpdate }

export interface UpdateBackend {
  /** Asks the feed (never downloads). Rejects when the feed cannot be read. */
  lookup(): Promise<LookupResult>;
  /** Downloads and verifies `version` (the one the last lookup announced). Must reject promptly once `signal` aborts. */
  download(version: string, onProgress: (progress: Progress) => void, signal: AbortSignal): Promise<void>;
  /** The backend limits silent transfers itself and has phases without progress (unpacking): the stalled-download watchdog is kept quiet. */
  readonly selfWatched?: boolean;
}

/** The download (or offer) this caller waited for was replaced by a newer version. */
export class SupersededError extends Error {
  constructor() { super('update superseded by a newer version'); this.name = 'UpdateSuperseded'; }
}
export const isSuperseded = (error: unknown): boolean => error instanceof SupersededError || (error as { name?: unknown } | null)?.name === 'UpdateSuperseded';

/**
 * startup: before the main window exists; background: the periodic check; manual: the user asked; recheck: the last look
 * before handing over (a failure of it never changes the state).
 */
export type CheckReason = 'startup' | 'background' | 'manual' | 'recheck';

export const STALL_MS = 2 * 60 * 1000;
export const LOOKUP_TIMEOUT_MS = 90 * 1000;
const NO_RESPONSE = 'Brak odpowiedzi serwera aktualizacji. Spróbuj ponownie.';

/** Numeric comparison of dotted versions; prerelease suffixes are ignored. Negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split(/[-+]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a); const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface CoordinatorOptions {
  backend: UpdateBackend;
  emit(state: UpdateState): void;
  /** Builds that never install on their own (portable): updates are only announced with the download link. */
  portable(): boolean;
  releasesUrl: string;
  now?(): number;
  stallMs?: number;
  lookupTimeoutMs?: number;
}

export class UpdateCoordinator {
  private state: UpdateState = { status: 'idle' };
  private target: string | undefined;
  /** Set when the target cannot be installed by this app. */
  private manual: { message?: string } | undefined;
  private downloaded: string | undefined;
  private download_: { version: string; promise: Promise<void>; abort: AbortController } | undefined;
  /** The previous download winding down; the next one starts only after it, so the backend never runs two. */
  private settling: Promise<void> = Promise.resolve();
  private locked: string | undefined;
  private newer: string | undefined;
  private blocked: string | undefined;
  private lastCheck = 0;
  private percent = 0;
  private checking: Promise<void> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private readonly targetListeners = new Set<() => void>();
  private readonly progressListeners = new Set<(percent: number) => void>();

  constructor(private readonly o: CoordinatorOptions) {}

  // ── state ───────────────────────────────────────────────────────────────

  getState(): UpdateState { return { ...this.state }; }
  /** The version the update is heading for (what every window, the status bar and the installer refer to). */
  currentTarget(): string | undefined { return this.target; }
  /** The version being handed to the installer, once that started. */
  handoverVersion(): string | undefined { return this.locked; }
  /** A newer version seen after the hand-over started; offered after the relaunch. */
  newerVersion(): string | undefined { return this.newer; }
  isDownloaded(version = this.target): boolean { return version !== undefined && this.downloaded === version; }
  lastCheckAt(): number { return this.lastCheck; }
  /** Whether the target can be downloaded and installed by this app. */
  installable(): boolean { return !!this.target && !this.manual && !this.o.portable(); }

  publish(): void { this.o.emit(this.getState()); }

  private set(next: UpdateState): void {
    clearTimeout(this.watchdog);
    this.state = { ...next, portable: next.portable ?? this.o.portable() };
    this.o.emit(this.getState());
    if (next.status === 'checking' || next.status === 'downloading') {
      this.watchdog = setTimeout(() => this.fail(new Error(NO_RESPONSE)), this.o.stallMs ?? STALL_MS);
      this.watchdog.unref?.();
    }
  }

  /** Reports a failure. A failed hand-over releases the lock, so the user can try again. */
  fail(error: unknown): void {
    this.locked = undefined;
    console.error('auto-update failed', error);
    const message = error instanceof Error ? error.message : String(error);
    this.set({ status: 'error', version: this.target ?? this.state.version, message: message || 'Nie udało się sprawdzić aktualizacji.' });
  }

  /** Stops the stalled-download watchdog (shutdown). */
  dispose(): void { clearTimeout(this.watchdog); }

  /** Shows a status that does not come from a lookup (unavailable in development, a failed previous update). */
  setStatus(next: UpdateState): void { this.set(next); }

  onTargetChange(listener: () => void): () => void { this.targetListeners.add(listener); return () => { this.targetListeners.delete(listener); }; }
  onProgress(listener: (percent: number) => void): () => void { this.progressListeners.add(listener); return () => { this.progressListeners.delete(listener); }; }

  // ── lookups ─────────────────────────────────────────────────────────────

  /**
   * Asks the feed and applies the answer. Resolves the installable update that is now the target (undefined: up to
   * date, only a download link is offered, or the hand-over is running). Rejects only for `startup` and `recheck`; the other reasons report the failure as status.
   */
  async check(reason: CheckReason): Promise<{ version: string } | undefined> {
    // While the hand-over runs the feed is still looked at, but only to remember a newer version (see `apply`).
    if (!this.checking) {
      const visible = ['idle', 'current', 'error', 'unavailable'].includes(this.state.status);
      this.lastCheck = (this.o.now ?? Date.now)();
      const run = (async () => {
        if (visible) this.set({ status: 'checking' });
        let result: LookupResult;
        try { result = await withTimeout(this.o.backend.lookup(), this.o.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS); }
        catch (error) {
          // A failing look while an update is already offered or downloading must not turn that into an error.
          if (visible && reason !== 'recheck') this.fail(error);
          throw error;
        }
        this.apply(result);
      })();
      this.checking = run;
      const clear = () => { if (this.checking === run) this.checking = undefined; };
      run.then(clear, clear);
    }
    try { await this.checking; }
    catch (error) { if (reason === 'startup' || reason === 'recheck') throw error; return undefined; }
    // An update this app cannot install (portable, macOS without write access) is not "found" for the callers that install.
    return this.locked || !this.target || this.manual ? undefined : { version: this.target };
  }

  /** Applies a feed answer; see the class comment for the rules. */
  private apply(result: LookupResult): void {
    const now = (this.o.now ?? Date.now)();
    const found = result.update;
    if (this.locked) {
      if (found && compareVersions(found.version, this.locked) > 0) this.newer = found.version;
      return;
    }
    if (found && found.version === this.blocked && this.target === found.version && this.manual) {
      // The install of this version was refused (macOS): the download page stays offered, it is only never installed.
      this.settle();
      return;
    }
    if (!found || found.version === this.blocked) {
      this.clearTarget();
      this.set({ status: 'current', version: found?.version ?? result.latest, checkedAt: now });
      return;
    }
    const manual = found.manual ?? (this.o.portable() ? {} : undefined);
    if (this.target === undefined || compareVersions(found.version, this.target) > 0) this.retarget(found.version, manual);
    // An older answer (a stale copy of the feed on a CDN or proxy) never replaces the target and never starts a second download.
    else if (found.version === this.target) this.manual = manual;
    this.settle();
  }

  private retarget(version: string, manual: { message?: string } | undefined): void {
    if (this.download_ && this.download_.version !== version) { this.download_.abort.abort(); this.download_ = undefined; }
    if (this.downloaded !== version) this.downloaded = undefined;
    this.target = version;
    this.manual = manual;
    this.percent = 0;
    for (const listener of [...this.targetListeners]) { try { listener(); } catch { /* a listener must not break the update */ } }
  }

  private clearTarget(): void {
    const had = this.target !== undefined;
    if (this.download_) { this.download_.abort.abort(); this.download_ = undefined; }
    this.target = undefined; this.manual = undefined; this.downloaded = undefined;
    if (had) for (const listener of [...this.targetListeners]) { try { listener(); } catch { /* ignored */ } }
  }

  /** Publishes what is known about the target and starts the background download when one is wanted. */
  private settle(): void {
    const version = this.target;
    if (!version) return;
    if (this.manual) { this.set({ status: 'available', version, url: this.o.releasesUrl, message: this.manual.message, portable: true }); return; }
    if (this.downloaded === version) {
      if (this.state.status !== 'ready' || this.state.version !== version) this.set({ status: 'ready', version });
      return;
    }
    if (this.download_?.version === version) {
      if (this.state.status !== 'downloading' || this.state.version !== version) this.set({ status: 'downloading', version, percent: this.percent });
      return;
    }
    this.set({ status: 'available', version });
    if (version !== this.blocked) void this.download().catch(() => { /* reported through the status */ });
  }

  // ── downloading ─────────────────────────────────────────────────────────

  /**
   * Downloads the target, or joins the download that is running for it; resolves when it is complete and verified.
   * Rejects with `SupersededError` when a newer target replaced it meanwhile.
   */
  download(): Promise<void> {
    const version = this.target;
    if (!version || this.manual) return Promise.reject(new Error('Nie udało się zainstalować aktualizacji.'));
    if (this.downloaded === version) return Promise.resolve();
    if (this.download_?.version === version) return this.download_.promise;
    const abort = new AbortController();
    const previous = this.settling;
    const promise = (async () => {
      await previous;
      if (abort.signal.aborted || this.target !== version) throw new SupersededError();
      this.percent = 0;
      this.set({ status: 'downloading', version, percent: 0 });
      const beat = this.o.backend.selfWatched
        ? setInterval(() => { if (this.state.status === 'downloading' && this.state.version === version) this.set({ ...this.state }); }, 20_000)
        : undefined;
      beat?.unref?.();
      try { await this.o.backend.download(version, (progress) => this.report(version, progress), abort.signal); }
      catch (error) {
        if (abort.signal.aborted || this.target !== version) throw new SupersededError();
        this.fail(error);
        throw error;
      }
      finally { clearInterval(beat); }
      if (abort.signal.aborted || this.target !== version) throw new SupersededError();
      this.downloaded = version;
      this.set({ status: 'ready', version });
    })();
    const entry = { version, promise, abort };
    this.download_ = entry;
    this.settling = promise.then(() => {}, () => {});
    const clear = () => { if (this.download_ === entry) this.download_ = undefined; };
    promise.then(clear, clear);
    return promise;
  }

  private report(version: string, progress: Progress): void {
    if (version !== this.target || this.locked || this.downloaded === version) return;
    const percent = Math.min(100, Math.max(0, Number.isFinite(progress.percent) ? progress.percent : 0));
    this.percent = percent;
    for (const listener of [...this.progressListeners]) { try { listener(percent); } catch { /* ignored */ } }
    this.set({
      status: 'downloading', version, percent,
      transferred: Math.max(0, progress.transferred || 0), total: Math.max(0, progress.total || 0), bytesPerSecond: Math.max(0, progress.bytesPerSecond || 0),
    });
  }

  addProgressListener(listener: (percent: number) => void): () => void { return this.onProgress(listener); }

  // ── hand-over ───────────────────────────────────────────────────────────

  /**
   * Takes the hand-over lock for the downloaded target (`expected`, when given, must still be it). From here on the
   * state is frozen until the app quits or the hand-over fails. False: nothing may be installed now.
   */
  lockHandover(expected?: string): boolean {
    const version = this.target;
    if (this.locked || !version || (expected !== undefined && expected !== version)) return false;
    if (this.manual || this.o.portable() || version === this.blocked || this.downloaded !== version) return false;
    this.locked = version;
    this.set({ status: 'installing', version });
    return true;
  }

  /** The hand-over could not start: release the lock and show the failure. */
  failHandover(error: unknown): void { this.fail(error); }

  /** The app turned out not to be replaceable (macOS): only the download page is offered for this version. */
  refuseInstall(version: string, message?: string): void {
    this.locked = undefined;
    this.downloaded = undefined;
    this.target = version;
    this.manual = { message };
    this.settle();
  }

  // ── blocking ────────────────────────────────────────────────────────────

  /** A version that failed to install is never offered again (until unblocked); a copy of it is withdrawn. */
  block(version: string | undefined): void {
    this.blocked = version;
    // An offer that only links to the download page (the install was refused) stays; it can never be installed anyway.
    if (version && this.target === version && !this.locked && !this.manual) {
      this.clearTarget();
      this.set({ status: 'current', checkedAt: (this.o.now ?? Date.now)() });
    }
  }
  blockedVersion(): string | undefined { return this.blocked; }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(NO_RESPONSE)), ms);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
