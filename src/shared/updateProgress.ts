/** Stages shown by the update window; the first four belong to the startup check that runs in the app itself. */
export type UpdateStage = 'checking' | 'ask' | 'downloading' | 'failed' | 'preparing' | 'closing' | 'installing' | 'launching' | 'done' | 'error';

export interface UpdateStrings {
  title: string;
  hint: string;
  stages: Record<'preparing' | 'closing' | 'installing' | 'launching', string>;
  done: string;
  slow: string;
  slowHint: string;
  open: string;
  close: string;
  /** Shown instead of the closing stage while the old app has still not exited. */
  waitingClose: string;
  /** Shown while the installer has not started replacing files (for example the administrator prompt is open). */
  waitingInstaller: string;
  /** Shown when installing takes unusually long. */
  installingLong: string;
  /** Shown when the user closes the window while the installer keeps going. */
  background: string;
}

/** Everything the detached update window needs; written to disk because the app exits before it starts. */
export interface UpdateSplashConfig {
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
  /** Rewritten every second by the window for as long as it supervises the installer. */
  heartbeatFlag: string;
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

/** Why the stage is taking long, so the window can say what it is really waiting for instead of showing a frozen bar. */
export type UpdateNote = 'waitingClose' | 'waitingInstaller' | 'installingLong';
export interface UpdateProgress { stage: UpdateStage; percent: number; note?: UpdateNote }

/** After this long without the old app exiting the window says it is waiting for it. */
export const WAIT_CLOSE_NOTE_MS = 8000;
/** After this long with the installer not touching any file the window says it is waiting for the installer. */
export const WAIT_INSTALLER_NOTE_MS = 15000;
/** After this long in the installing stage the window adds that it is slower than usual. */
export const SLOW_INSTALL_NOTE_MS = 60000;
/** Without any sign that files are being replaced the estimate may not run past this fraction of the stage. */
const UNCONFIRMED_INSTALL_FRACTION = 0.6;

/** What the close control (X, Escape, Alt+F4) does at each stage of the detached window. */
export type CloseAction = 'hide' | 'exit';

/**
 * The installer is started by the time this window exists, so closing it must never end the update:
 * while work is in flight the window only hides; once it is finished (or has given up) it exits.
 */
export function closeAction(stage: UpdateStage): CloseAction {
  return stage === 'done' || stage === 'error' ? 'exit' : 'hide';
}

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

  constructor(private readonly baselineBytes: number) {}

  update(s: UpdateSnapshot): UpdateProgress {
    let stage: UpdateStage;
    let percent: number;
    let note: UpdateNote | undefined;
    if (s.closed) this.closedAt ??= s.elapsedMs;
    if (s.installed) this.installedAt ??= s.elapsedMs;
    if (s.dirBytes !== undefined && s.closed) this.minBytes = Math.min(this.minBytes, s.dirBytes);

    if (s.ready) {
      stage = 'done';
      percent = 100;
    } else if (s.installed) {
      stage = 'launching';
      percent = INSTALL_END + (LAUNCH_END - INSTALL_END) * ease((s.elapsedMs - (this.installedAt ?? s.elapsedMs)) / 5000);
    } else if (s.closed) {
      stage = 'installing';
      const since = s.elapsedMs - (this.closedAt ?? s.elapsedMs);
      const measured = this.sizeFraction(s.dirBytes);
      // The estimate by time is only trusted until the installer has demonstrably started removing files.
      const estimate = Math.min(0.85 * ease(since / 25000), measured > 0 ? 0.85 : UNCONFIRMED_INSTALL_FRACTION);
      percent = CLOSE_END + (INSTALL_END - CLOSE_END) * Math.min(Math.max(measured, estimate), 0.97);
      if (measured === 0 && since > WAIT_INSTALLER_NOTE_MS) note = 'waitingInstaller';
      else if (since > SLOW_INSTALL_NOTE_MS) note = 'installingLong';
    } else if (s.elapsedMs < 1200) {
      stage = 'preparing';
      percent = PREPARE_END * ease(s.elapsedMs / 600);
    } else {
      stage = 'closing';
      percent = PREPARE_END + (CLOSE_END - PREPARE_END) * ease((s.elapsedMs - 1200) / 2500);
      if (s.elapsedMs > WAIT_CLOSE_NOTE_MS) note = 'waitingClose';
    }
    this.shown = Math.max(this.shown, Math.min(100, percent));
    const shown = Math.round(this.shown * 10) / 10;
    return note ? { stage, percent: shown, note } : { stage, percent: shown };
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
