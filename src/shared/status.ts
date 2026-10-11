// Per-cell agent status. Precise signals (Claude hooks, Codex OSC 9) win; otherwise a heuristic:
// after the user submits (Enter), non-echo output means "working", and silence after that
// means the agent finished and is "waiting" for the user. Nothing is inferred before a turn was
// observed in this session, so restored/resumed agents never start out as "waiting".

export type CellStatus = 'idle' | 'working' | 'waiting' | 'exited';
/** prompt = UserPromptSubmit, stop = Stop, notify = permission/question, busy = tool or subagent activity. */
export type HookEvent = 'prompt' | 'stop' | 'notify' | 'busy';
export type StatusCause = 'heuristic' | 'hook';

export const ECHO_MS = 250;
/** Output separated by more than this starts a new activity run. */
export const GAP_MS = 1500;
/** An uninterrupted output run this long means the agent is busy (e.g. its "Working (12s)" timer). */
export const SUSTAIN_MS = 3000;
/** Ticks further apart than this mean the machine slept or the window was throttled. */
export const SUSPEND_MS = 10_000;

/** Replies the terminal itself writes to the pty (focus reports, cursor/device reports, mouse) are not user input. */
export function isUserInput(data: string): boolean {
  return !/^\x1b(?:\[(?:[IO]|\??[\d;]*[Rcn]|<[\d;]*[Mm]|M[\s\S]{3})|\][\s\S]*|P[\s\S]*)$/.test(data);
}

/** Notify only for a real transition seen in this session: working -> waiting, or a live agent hook. */
export function shouldNotify(prev: CellStatus, next: CellStatus, cause: StatusCause): boolean {
  if (next !== 'waiting' || prev === 'waiting' || prev === 'exited') return false;
  return cause === 'hook' || prev === 'working';
}

export class StatusTracker {
  status: CellStatus = 'idle';
  lastCause: StatusCause = 'heuristic';
  private lastInput = -Infinity;
  private lastOutput = -Infinity;
  private lastTick = -Infinity;
  private activityStart = -Infinity;
  private armed = false;
  private hooked: boolean;
  private turnObserved = false;
  private waitingFromNotify = false;

  /** `preciseHooks`: the agent reports through hooks, so screen heuristics and bells are never used. */
  constructor(private readonly quietMs = 2000, private readonly preciseHooks = false) {
    this.hooked = preciseHooks;
  }

  input(now: number, submitted: boolean): void {
    if (this.status === 'exited') return;
    this.lastInput = now;
    if (!submitted) return;
    this.armed = true;
    this.turnObserved = true;
    if (this.status !== 'waiting') return;
    if (!this.hooked) this.status = 'idle';
    else if (this.waitingFromNotify) this.set('working', 'hook'); // permission/question answered
    // Waiting after Stop: UserPromptSubmit decides (an empty Enter must not fake work).
  }

  output(now: number): void {
    if (this.status === 'exited' || this.hooked) return;
    // Keystroke echo / prompt redraw. A working agent's spinner must still count while the user types.
    if (now - this.lastInput < ECHO_MS && this.status !== 'working') return;
    if (now - this.lastOutput > GAP_MS) this.activityStart = now;
    this.lastOutput = now;
    if (this.armed) {
      this.status = 'working';
      return;
    }
    // Recover from a premature "waiting" (pause or notification mid-turn): an agent that keeps
    // redrawing for SUSTAIN_MS is clearly still working. Needs a turn started in this session.
    if (this.turnObserved && now - this.activityStart >= SUSTAIN_MS) {
      this.status = 'working';
      this.armed = true;
    }
  }

  hook(event: HookEvent): void {
    if (this.status === 'exited') return;
    this.hooked = true;
    this.turnObserved = true;
    this.armed = false;
    this.waitingFromNotify = event === 'notify';
    this.set(event === 'prompt' || event === 'busy' ? 'working' : 'waiting', 'hook');
  }

  /** Terminal notification (OSC 9 / bell). Ignored once precise hooks drive the status. */
  osc9(): void {
    if (this.status === 'exited' || this.hooked || !this.turnObserved) return;
    this.armed = false;
    this.set('waiting', 'heuristic');
  }

  exited(): void {
    this.status = 'exited';
  }

  reset(): void {
    this.status = 'idle';
    this.armed = false;
    this.hooked = this.preciseHooks;
    this.turnObserved = false;
    this.waitingFromNotify = false;
    this.lastInput = this.lastOutput = this.activityStart = this.lastTick = -Infinity;
  }

  tick(now: number): CellStatus {
    // After sleep / throttled timers the silence is not the agent's: restart the quiet window.
    if (this.lastTick > -Infinity && now - this.lastTick > SUSPEND_MS && this.lastOutput > -Infinity) this.lastOutput = now;
    this.lastTick = now;
    if (this.status === 'working' && !this.hooked && now - this.lastOutput >= this.quietMs) {
      this.armed = false;
      this.set('waiting', 'heuristic');
    }
    return this.status;
  }

  private set(status: CellStatus, cause: StatusCause): void {
    this.status = status;
    this.lastCause = cause;
  }
}

export interface StatusCounts {
  working: number;
  waiting: number;
  exited: number;
}

export function aggregate(list: Iterable<CellStatus>): StatusCounts {
  const c: StatusCounts = { working: 0, waiting: 0, exited: 0 };
  for (const s of list) if (s !== 'idle') c[s]++;
  return c;
}
