/**
 * Decides and orchestrates the update check that runs before the main window exists. Free of Electron
 * imports: every side effect is injected, so the fail-open rules can be tested without an app.
 */

export const CHECK_TIMEOUT_MS = 8000;
/** The window stays hidden for this long, so a quick "no update" answer never flashes it. */
export const SHOW_AFTER_MS = 400;
/** A download that reports nothing for this long counts as failed. */
export const DOWNLOAD_STALL_MS = 60 * 1000;
/** The whole download may not take longer than this, however steadily it progresses. */
export const DOWNLOAD_TOTAL_MS = 3 * 60 * 1000;
/** Showing the installing window and starting the installer is expected to take seconds. */
export const HANDOFF_TIMEOUT_MS = 20 * 1000;
/** How long the failure notice stays visible before the current version starts. */
export const ERROR_HOLD_MS = 2500;
/** After a failed update the gate is skipped for this long, so a broken release cannot delay every launch. */
export const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface GateEnv {
  platform: string;
  packaged: boolean;
  portable: boolean;
  autoInstall: boolean;
  /** An update failed less than `FAILURE_COOLDOWN_MS` ago. */
  recentFailure: boolean;
}

/** The gate exists only for the installed Windows build with automatic updates. */
export function shouldGateOnStartup(env: GateEnv): boolean {
  return env.platform === 'win32' && env.packaged && !env.portable && env.autoInstall && !env.recentFailure;
}

export interface FailureRecord { version: string; at: number }

/** Parses a persisted failure record; anything malformed counts as no failure. */
export function parseFailure(raw: unknown): FailureRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { version, at } = raw as Record<string, unknown>;
  return typeof version === 'string' && typeof at === 'number' && Number.isFinite(at) ? { version, at } : undefined;
}

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

export const isRecentFailure = (failure: FailureRecord | undefined, now: number): boolean =>
  !!failure && now - failure.at >= 0 && now - failure.at < FAILURE_COOLDOWN_MS;

export type GateView =
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'installing'; version: string }
  | { kind: 'failed'; version: string };

export interface GateDeps {
  /** Resolves the available update, or undefined when the app is current. */
  check(): Promise<{ version: string } | undefined>;
  /** Called when the check outlived its timeout; the late answer must not be used by the gate. */
  abandonCheck?(): void;
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Shows (creating if needed) and updates the gate window. */
  show(view: GateView): void;
  hide(): void;
  /** Starts the installing window and installer; calls `hide` once the hand-over is visible. True when it took over. */
  handoff(version: string, hide: () => void): Promise<boolean>;
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
  errorHoldMs?: number;
}

export type GateResult = 'start-app' | 'installing';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class CheckTimeout extends Error { constructor() { super('update check timed out'); } }

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
export async function runStartupGate(deps: GateDeps): Promise<GateResult> {
  const checkTimeout = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  let shown = false;
  const show = (view: GateView) => { shown = true; try { deps.show(view); } catch { /* the window is optional */ } };
  const hide = () => { if (shown) { shown = false; try { deps.hide(); } catch { /* already gone */ } } };
  const showTimer = setTimeout(() => show({ kind: 'checking' }), deps.showAfterMs ?? SHOW_AFTER_MS);
  let found: { version: string } | undefined;
  try {
    const pending = deps.check();
    // A check that is abandoned later may still reject; that must not become an unhandled rejection.
    pending.catch(() => {});
    try { found = await within(pending, checkTimeout, () => new CheckTimeout()); }
    catch (error) { if (error instanceof CheckTimeout) deps.abandonCheck?.(); throw error; }
  } catch {
    clearTimeout(showTimer);
    hide();
    return 'start-app';
  }
  clearTimeout(showTimer);
  if (!found || found.version === deps.skipVersion) { hide(); return 'start-app'; }

  const { version } = found;
  try {
    show({ kind: 'downloading', version, percent: 0 });
    await within(downloadWithStall(deps, version, show), deps.downloadTotalMs ?? DOWNLOAD_TOTAL_MS, () => new Error('download took too long'));
    show({ kind: 'installing', version });
    try { deps.markAttempt?.(version); } catch { /* the attempt marker is best effort */ }
    const handedOver = deps.handoff(version, hide);
    handedOver.catch(() => {});
    if (await within(handedOver, deps.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS, () => new Error('installer hand-over timed out'))) return 'installing';
    throw new Error('installer hand-over failed');
  } catch {
    try { deps.recordFailure(version); } catch { /* the cooldown is best effort */ }
    show({ kind: 'failed', version });
    await sleep(deps.errorHoldMs ?? ERROR_HOLD_MS);
    hide();
    return 'start-app';
  }
}

/** Downloads with a stall watchdog that restarts on every progress report. */
function downloadWithStall(deps: GateDeps, version: string, show: (view: GateView) => void): Promise<void> {
  const stallMs = deps.downloadStallMs ?? DOWNLOAD_STALL_MS;
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const arm = () => { if (settled) return; clearTimeout(timer); timer = setTimeout(() => { settled = true; reject(new Error('download stalled')); }, stallMs); };
    arm();
    deps.download((percent) => {
      arm();
      show({ kind: 'downloading', version, percent: Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0)) });
    }).then(() => { settled = true; clearTimeout(timer); resolve(); }, (error) => { settled = true; clearTimeout(timer); reject(error); });
  });
}
