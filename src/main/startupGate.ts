/**
 * Decides and orchestrates the update check that runs before the main window exists. Free of Electron
 * imports: every side effect is injected, so the fail-open rules can be tested without an app.
 */

import type { UpdateMode } from '../shared/updateMode';
import { compareVersions, isSuperseded } from './updateCoordinator';

export const CHECK_TIMEOUT_MS = 8000;
/**
 * The window stays hidden for this long, so a quick "no update" answer never flashes it. A window that did
 * appear closes the moment the answer is in: no answer is ever held back to keep a window on screen.
 */
export const SHOW_AFTER_MS = 800;
/** A download that reports nothing for this long counts as failed. */
export const DOWNLOAD_STALL_MS = 60 * 1000;
/** The whole download may not take longer than this, however steadily it progresses. */
export const DOWNLOAD_TOTAL_MS = 3 * 60 * 1000;
/** Showing the installing window and starting the installer is expected to take seconds. */
/** The last look at the feed before the hand-over may take this long; without an answer the downloaded update proceeds. */
export const RECHECK_TIMEOUT_MS = 5 * 1000;
export const HANDOFF_TIMEOUT_MS = 20 * 1000;
/** How long the failure notice stays visible before the current version starts. */
export const ERROR_HOLD_MS = 2500;
/** After a failed update the gate is skipped for this long, so a broken release cannot delay every launch. */
export const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface GateEnv {
  platform: string;
  packaged: boolean;
  portable: boolean;
  mode: UpdateMode;
  /** An update failed less than `FAILURE_COOLDOWN_MS` ago. */
  recentFailure: boolean;
}

/**
 * The gate exists only for the installed Windows build and the macOS app in the 'ask' (Automatic) mode; 'manual' starts the
 * app at once. On macOS an app that cannot replace itself (disk image, read-only folder, ...) has nothing to offer, so the
 * start-up check finds no installable update and the prompt never appears.
 */
export function shouldGateOnStartup(env: GateEnv): boolean {
  return (env.platform === 'win32' || env.platform === 'darwin') && env.packaged && !env.portable && env.mode === 'ask' && !env.recentFailure;
}

export interface FailureRecord { version: string; at: number }

/** Parses a persisted failure record; anything malformed counts as no failure. */
export function parseFailure(raw: unknown): FailureRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { version, at } = raw as Record<string, unknown>;
  return typeof version === 'string' && typeof at === 'number' && Number.isFinite(at) ? { version, at } : undefined;
}

export { compareVersions };

/**
 * A record of an attempt only counts while the version it targeted is not running yet: after a successful update the record
 * names the running version, and the next start (which may offer a still newer release) must not be held back by it.
 */
export const isActiveFailure = (failure: FailureRecord | undefined, currentVersion: string, now: number): boolean =>
  !!failure && compareVersions(failure.version, currentVersion) > 0 && isRecentFailure(failure, now);

/** The version the startup prompt must not offer again: only while its failure is active (after the cooldown it is offered again). */
export const gateSkipVersion = (failure: FailureRecord | undefined, currentVersion: string, now: number): string | undefined =>
  failure && isActiveFailure(failure, currentVersion, now) ? failure.version : undefined;

export const isRecentFailure = (failure: FailureRecord | undefined, now: number): boolean =>
  !!failure && now - failure.at >= 0 && now - failure.at < FAILURE_COOLDOWN_MS;

export type GateView =
  | { kind: 'checking' }
  | { kind: 'ask'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; version: string };

export interface GateDeps {
  /** Resolves the available update, or undefined when the app is current. */
  check(): Promise<{ version: string } | undefined>;
  /** The last look at the feed before the installer is started (defaults to `check`); a failure of it never blocks the update. */
  recheck?(): Promise<{ version: string } | undefined>;
  /** Whether `version` is already downloaded and verified (the window then goes straight to the hand-over). */
  isDownloaded?(version: string): boolean;
  /** The version the update is currently heading for; it changes when a newer release supersedes the offer. */
  target?(): string | undefined;
  /** Registers the callback called whenever the target version changed (a newer release appeared); returns the unsubscribe. */
  onTargetChange?(listener: () => void): () => void;
  /** Called when the check outlived its timeout; the late answer must not be used by the gate. */
  abandonCheck?(): void;
  /**
   * Starts downloading the offered update; called as soon as the prompt is shown, so "Install now" can go straight
   * to the hand-over. When the user chooses "Later" the download is left running (it becomes an ordinary background
   * download), so it may still settle after the gate has returned.
   */
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Shows (creating if needed) and updates the gate window. */
  show(view: GateView): void;
  hide(): void;
  /**
   * Registers the callback the window calls when the user closes it (X, Escape). Cancelling is only honoured
   * until the installer is being handed over; after that the update must run to the end.
   */
  onCancel?(cancel: () => void): void;
  /** Registers the callback the window calls when the user picks "Install now" in the prompt. */
  onInstall?(install: () => void): void;
  /** Starts the installing window and installer; calls `hide` once the hand-over is visible. True when it took over. */
  handoff(version: string, hide: () => void, signal?: AbortSignal): Promise<boolean>;
  /**
   * True once the installer is being started: a hand-over that outlived its deadline but is committed is not a failure
   * (the app is about to quit), and one that was still preparing is abandoned through the signal given to `handoff`.
   */
  handoffCommitted?(): boolean;
  /** Written right before the installer starts, so an installer that fails outside the app still counts as a failure. */
  markAttempt?(version: string): void;
  recordFailure(version: string): void;
  /** A version that already failed; it is never retried within this launch. */
  skipVersion?: string;
  checkTimeoutMs?: number;
  showAfterMs?: number;
  downloadStallMs?: number;
  downloadTotalMs?: number;
  handoffTimeoutMs?: number;
  recheckTimeoutMs?: number;
  errorHoldMs?: number;
}

export type GateResult = 'start-app' | 'installing';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class CheckTimeout extends Error { constructor() { super('update check timed out'); } }
class HandoverTimeout extends Error { constructor() { super('installer hand-over timed out'); } }
class GateCancelled extends Error { constructor() { super('update gate cancelled by the user'); } }

/** Rejects with `timeout()` when `promise` has not settled within `ms`; the timer never outlives the race. */
function within<T>(promise: Promise<T>, ms: number, timeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout()), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
/**
 * Runs the pre-start check. Every failure path (offline, error, timeout, exception) resolves 'start-app';
 * only a completed hand-over to the installer resolves 'installing'.
 */
export function runStartupGate(deps: GateDeps): Promise<GateResult> {
  return runFlow(deps, { prompt: true });
}

/**
 * The update window opened from the status bar: the version to install is already known, so there is no check and no
 * prompt; the window shows the download (joining a running one), then the hand-over. 'start-app' means nothing was
 * handed over and the app simply keeps running.
 */
export function runInstallWindow(deps: GateDeps, version: string): Promise<GateResult> {
  return runFlow(deps, { prompt: false, version });
}

interface FlowOptions {
  /** Ask "Install now / Later" once the check found an update. */
  prompt: boolean;
  /** The update to install is already known: skip the check. */
  version?: string;
}

async function runFlow(deps: GateDeps, opts: FlowOptions): Promise<GateResult> {
  const checkTimeout = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  let shown = false;
  let stopped = false;
  const show = (view: GateView) => { if (stopped) return; shown = true; try { deps.show(view); } catch { /* the window is optional */ } };
  const hide = () => { if (shown) { shown = false; try { deps.hide(); } catch { /* already gone */ } } };
  const showTimer = opts.version ? undefined : setTimeout(() => show({ kind: 'checking' }), deps.showAfterMs ?? SHOW_AFTER_MS);
  // The user may close the window until the installer is handed over; then the app starts as it is.
  let cancellable = true;
  let cancel = () => {};
  const cancelled = new Promise<never>((_, reject) => { cancel = () => { if (cancellable) { stopped = true; reject(new GateCancelled()); } }; });
  cancelled.catch(() => {});
  try { deps.onCancel?.(() => cancel()); } catch { /* the window is optional */ }
  let install = () => {};
  const installChosen = new Promise<void>((resolve) => { install = resolve; });
  try { deps.onInstall?.(() => install()); } catch { /* the window is optional */ }
  let found: { version: string } | undefined = opts.version ? { version: opts.version } : undefined;
  if (!opts.version) {
    try {
      const pending = deps.check();
      // A check that is abandoned later may still reject; that must not become an unhandled rejection.
      pending.catch(() => {});
      try { found = await Promise.race([within(pending, checkTimeout, () => new CheckTimeout()), cancelled]); }
      catch (error) { if (error instanceof CheckTimeout || error instanceof GateCancelled) deps.abandonCheck?.(); throw error; }
    } catch {
      clearTimeout(showTimer);
      hide();
      return 'start-app';
    }
  }
  clearTimeout(showTimer);
  if (!found || found.version === deps.skipVersion) { hide(); return 'start-app'; }

  let version = found.version;
  /** The hand-over was given up before the installer started: nothing is wrong with the version, so no failure is recorded. */
  let handoverAbandoned = false;
  let unsubscribe: (() => void) | undefined;
  try {
    // The download starts together with the prompt: the offer is already an explicit statement that an update
    // exists, and downloading is not installing. Its progress only reaches the window once "Install now" was chosen.
    let chosen = !opts.prompt;
    let percent = 0;
    let downloaded = false;
    let handingOver = false;
    let download: Promise<void> = Promise.resolve();
    const startDownload = () => {
      const mine = version;
      percent = 0; downloaded = deps.isDownloaded?.(mine) ?? false;
      const attempt = downloadWithStall(deps, (next) => {
        if (version !== mine) return;
        percent = next;
        if (chosen) show({ kind: 'downloading', version, percent });
      });
      // A download nobody waits for any more (the user chose "Later", or a newer version replaced it) may still fail;
      // the updater reports that itself.
      attempt.then(() => { if (version === mine) downloaded = true; }, () => {});
      download = attempt;
    };
    /** A newer release became the target: every view moves to it and its download is joined. */
    const retarget = (next: string | undefined) => {
      if (handingOver || !next || next === version) return false;
      version = next;
      startDownload();
      show(chosen ? { kind: 'downloading', version, percent: 0 } : { kind: 'ask', version });
      return true;
    };
    try { unsubscribe = deps.onTargetChange?.(() => { retarget(deps.target?.()); }); } catch { /* the listener is optional */ }
    startDownload();
    if (opts.prompt) {
      // "Later" (the button, X or Escape) rejects with GateCancelled below and starts the current version.
      show({ kind: 'ask', version });
      await Promise.race([installChosen, cancelled]);
      chosen = true;
    }
    for (;;) {
      const round = version;
      if (!downloaded) {
        show({ kind: 'downloading', version, percent });
        try { await Promise.race([within(download, deps.downloadTotalMs ?? DOWNLOAD_TOTAL_MS, () => new Error('download took too long')), cancelled]); }
        catch (error) {
          if (error instanceof GateCancelled) throw error;
          if (isSuperseded(error)) {
            // The coordinator moved on: follow its target; if it has none the offer is simply gone.
            if (!retarget(deps.target?.()) && version === round) throw error;
            continue;
          }
          if (version !== round) continue;
          throw error;
        }
        if (version !== round) continue;
      }
      // The last look at the feed: a release published while this one was offered or downloading replaces it.
      let again: { version: string } | undefined | 'unknown' = 'unknown';
      try { again = await Promise.race([within((deps.recheck ?? deps.check)(), deps.recheckTimeoutMs ?? RECHECK_TIMEOUT_MS, () => new CheckTimeout()), cancelled]); }
      catch (error) { if (error instanceof GateCancelled) throw error; /* the feed cannot be read: what is downloaded stays the target */ }
      if (again !== 'unknown' && again) retarget(again.version);
      if (version !== round) continue;
      if (again === undefined) { cancellable = false; hide(); return 'start-app'; }
      // Same tick as the hand-over below: nothing can supersede the target in between.
      if (retarget(deps.target?.())) continue;
      break;
    }
    cancellable = false;
    handingOver = true;
    show({ kind: 'installing', version });
    try { deps.markAttempt?.(version); } catch { /* the attempt marker is best effort */ }
    const deadline = new AbortController();
    const handedOver = deps.handoff(version, hide, deadline.signal);
    handedOver.catch(() => {});
    try {
      if (await within(handedOver, deps.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS, () => new HandoverTimeout())) return 'installing';
    } catch (error) {
      if (error instanceof HandoverTimeout) {
        // Slow preparation (the update window runtime) is not a failed installer: if the installer was already started the
        // update runs on, otherwise the hand-over is abandoned and the downloaded update is kept.
        if (deps.handoffCommitted?.()) return 'installing';
        deadline.abort();
        handoverAbandoned = true;
      }
      throw error;
    }
    throw new Error('installer hand-over failed');
  } catch (error) {
    const beforeHandoff = cancellable;
    if (error instanceof GateCancelled) { cancellable = false; hide(); return 'start-app'; }
    // An offer that stood for a long time may be gone (a newer release replaced it): look once more before
    // calling it a failure, and never block a version that was merely not found any more.
    if (beforeHandoff) {
      try {
        const again = await Promise.race([within(deps.check(), deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS, () => new CheckTimeout()), cancelled]);
        if (!again || again.version !== version) { cancellable = false; hide(); return 'start-app'; }
      } catch (second) {
        if (second instanceof GateCancelled) { cancellable = false; hide(); return 'start-app'; }
        /* the second look failed too: treat the original error as it is */
      }
    }
    cancellable = false;
    if (!handoverAbandoned) { try { deps.recordFailure(version); } catch { /* the cooldown is best effort */ } }
    show({ kind: 'failed', version });
    await sleep(deps.errorHoldMs ?? ERROR_HOLD_MS);
    hide();
    return 'start-app';
  } finally {
    try { unsubscribe?.(); } catch { /* nothing to undo */ }
  }
}

/** Downloads with a stall watchdog that restarts on every progress report. */
function downloadWithStall(deps: GateDeps, onPercent: (percent: number) => void): Promise<void> {
  const stallMs = deps.downloadStallMs ?? DOWNLOAD_STALL_MS;
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const arm = () => { if (settled) return; clearTimeout(timer); timer = setTimeout(() => { settled = true; reject(new Error('download stalled')); }, stallMs); };
    arm();
    deps.download((percent) => {
      arm();
      onPercent(Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0)));
    }).then(() => { settled = true; clearTimeout(timer); resolve(); }, (error) => { settled = true; clearTimeout(timer); reject(error); });
  });
}
