/** Stages shown by the update window while the installer replaces the running app. */
export type UpdateStage = 'preparing' | 'closing' | 'installing' | 'launching' | 'done' | 'error';

export interface UpdateStrings {
  title: string;
  hint: string;
  stages: Record<'preparing' | 'closing' | 'installing' | 'launching', string>;
  done: string;
  doneQuit: string;
  slow: string;
  slowHint: string;
  open: string;
  close: string;
}

/** Everything the detached update window needs; written to disk because the app exits before it starts. */
export interface UpdateSplashConfig {
  mode: 'relaunch' | 'quit';
  fromVersion: string;
  version: string;
  oldPid: number;
  installDir: string;
  appExe: string;
  /** Written by the NSIS installer once the files are in place. */
  installedFlag: string;
  /** Written by the new app after its window is ready. */
  readyFlag: string;
  /** Written by the window as soon as it is visible, so the app can quit without a blank gap. */
  shownFlag: string;
  /** Written by the app when the hand-off to the installer failed. */
  abortFlag: string;
  runtimeDir: string;
  workDir: string;
  timeoutMs: number;
  strings: UpdateStrings;
}

export interface UpdateSnapshot {
  /** Elapsed time since the window started. */
  elapsedMs: number;
  /** Whether the previous app process has exited. */
  closed: boolean;
  /** Whether the installer finished copying files. */
  installed: boolean;
  /** Whether the new app reported a ready window. */
  ready: boolean;
  /** Current size of the install directory, when sampled. */
  dirBytes?: number;
}

export interface UpdateProgress { stage: UpdateStage; percent: number }

/** Progress ceilings per stage; the bar only moves forward and never shows 100 before the app is ready. */
const PREPARE_END = 8;
const CLOSE_END = 16;
const INSTALL_END = 90;
const LAUNCH_END = 99;

const ease = (value: number) => 1 - Math.exp(-value);

/**
 * The installer reports no progress, so the percentage blends hard signals (process exit, installer
 * completion, ready window) with an estimate from the install directory shrinking and regrowing.
 */
export class UpdateProgressModel {
  private minBytes = Infinity;
  private shown = 0;
  private closedAt?: number;
  private installedAt?: number;

  constructor(private readonly baselineBytes: number, private readonly mode: 'relaunch' | 'quit' = 'relaunch') {}

  update(s: UpdateSnapshot): UpdateProgress {
    let stage: UpdateStage;
    let percent: number;
    if (s.closed) this.closedAt ??= s.elapsedMs;
    if (s.installed) this.installedAt ??= s.elapsedMs;
    if (s.dirBytes !== undefined && s.closed) this.minBytes = Math.min(this.minBytes, s.dirBytes);

    if (s.ready || (this.mode === 'quit' && s.installed)) {
      stage = 'done';
      percent = 100;
    } else if (s.installed) {
      stage = 'launching';
      percent = INSTALL_END + (LAUNCH_END - INSTALL_END) * ease((s.elapsedMs - (this.installedAt ?? s.elapsedMs)) / 5000);
    } else if (s.closed) {
      stage = 'installing';
      const since = s.elapsedMs - (this.closedAt ?? s.elapsedMs);
      const frac = Math.max(this.sizeFraction(s.dirBytes), 0.85 * ease(since / 25000));
      percent = CLOSE_END + (INSTALL_END - CLOSE_END) * Math.min(frac, 0.97);
    } else if (s.elapsedMs < 1200) {
      stage = 'preparing';
      percent = PREPARE_END * ease(s.elapsedMs / 600);
    } else {
      stage = 'closing';
      percent = PREPARE_END + (CLOSE_END - PREPARE_END) * ease((s.elapsedMs - 1200) / 2500);
    }
    this.shown = Math.max(this.shown, Math.min(100, percent));
    return { stage, percent: Math.round(this.shown * 10) / 10 };
  }

  /** The installer removes the old files and extracts the new ones: a valley in directory size. */
  private sizeFraction(bytes?: number): number {
    if (!bytes || this.baselineBytes <= 0 || this.minBytes === Infinity) return 0;
    const baseline = this.baselineBytes;
    const removed = Math.min(1, Math.max(0, (baseline - this.minBytes) / baseline));
    if (removed < 0.2) return 0;
    const regrown = Math.min(1, Math.max(0, (bytes - this.minBytes) / Math.max(1, baseline - this.minBytes)));
    return 0.3 * removed + 0.7 * regrown;
  }
}
