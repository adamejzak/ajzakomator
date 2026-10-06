// Per-cell agent status. Precise signals (Claude hooks, Codex OSC 9) win; otherwise a heuristic:
// after the user submits (Enter), non-echo output means "working", and silence after that
// means the agent finished and is "waiting" for the user.

export type CellStatus = 'idle' | 'working' | 'waiting' | 'exited';
export type HookEvent = 'prompt' | 'stop' | 'notify';

export const ECHO_MS = 250;
/** Output separated by more than this starts a new activity run. */
export const GAP_MS = 1500;
/** An uninterrupted output run this long means the agent is busy (e.g. its "Working (12s)" timer). */
export const SUSTAIN_MS = 3000;

export class StatusTracker {
  status: CellStatus = 'idle';
  private lastInput = -Infinity;
  private lastOutput = -Infinity;
  private activityStart = -Infinity;
  private armed = false;
  private hooked = false;

  constructor(private readonly quietMs = 2000) {}

  input(now: number, submitted: boolean): void {
    if (this.status === 'exited') return;
    this.lastInput = now;
    if (submitted) this.armed = true;
    if (this.status === 'waiting') this.status = 'idle';
  }

  output(now: number): void {
    if (this.status === 'exited' || this.hooked) return;
    if (now - this.lastInput < ECHO_MS) return; // keystroke echo / prompt redraw
    if (now - this.lastOutput > GAP_MS) this.activityStart = now;
    this.lastOutput = now;
    if (this.armed) {
      this.status = 'working';
      return;
    }
    // Recover from a premature "waiting" (pause or notification mid-turn): an agent that keeps
    // redrawing for SUSTAIN_MS is clearly still working.
    if (now - this.activityStart >= SUSTAIN_MS) {
      this.status = 'working';
      this.armed = true;
    }
  }

  hook(event: HookEvent): void {
    if (this.status === 'exited') return;
    this.hooked = true;
    this.armed = false;
    this.status = event === 'prompt' ? 'working' : 'waiting';
  }

  /** Terminal notification (OSC 9 / bell). Ignored once precise hooks drive the status. */
  osc9(): void {
    if (this.status === 'exited' || this.hooked) return;
    this.armed = false;
    this.status = 'waiting';
  }

  /** User looked at the cell: "waiting" has been seen. */
  acknowledge(): void {
    if (this.status === 'waiting') this.status = 'idle';
  }

  exited(): void {
    this.status = 'exited';
  }

  reset(): void {
    this.status = 'idle';
    this.armed = false;
    this.hooked = false;
    this.lastInput = this.lastOutput = this.activityStart = -Infinity;
  }

  tick(now: number): CellStatus {
    if (this.status === 'working' && !this.hooked && now - this.lastOutput >= this.quietMs) {
      this.status = 'waiting';
      this.armed = false;
    }
    return this.status;
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
