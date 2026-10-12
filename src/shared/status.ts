// Per-cell agent status. Precise signals (Claude hooks, Codex OSC 9) win; otherwise (and until the first
// hook arrives) a heuristic:
// after the user submits (Enter), non-echo output means "working", and silence after that
// means the agent finished and is "waiting" for the user. Nothing is inferred before a turn was
// observed in this session, so restored/resumed agents never start out as "waiting".

export type CellStatus = 'idle' | 'working' | 'waiting' | 'exited';
/**
 * prompt = UserPromptSubmit, stop = Stop, stopbg = Stop while background tasks still run, notify = permission/question,
 * busy = tool or subagent activity, fail = StopFailure (the turn ended with an API error), session = SessionStart.
 */
export type HookEvent = 'prompt' | 'stop' | 'stopbg' | 'notify' | 'busy' | 'fail' | 'session';
export type StatusCause = 'heuristic' | 'hook';
/** Why the cell is waiting: the turn finished (Stop / silence), the agent needs an answer, or the turn failed. */
export type StatusReason = 'done' | 'attention' | 'error';

/** Diagnostics that travel with a hook event (never any message text). */
export interface HookInfo {
  /** Stop: number of listed background tasks and how many of them are not clearly finished. */
  tasks?: number;
  active?: number;
  /** Stop: distinct task status strings. */
  statuses?: string[];
  /** StopFailure: the error code. */
  error?: string;
  /** SessionStart: startup | resume | clear | compact | fork. */
  source?: string;
}

export const ECHO_MS = 250;
/** Output right after a focus report / mouse report (a click on the cell) is the agent redrawing, not working. */
export const FOCUS_ECHO_MS = 1000;
/** Output separated by more than this starts a new activity run. */
export const GAP_MS = 1500;
/** An uninterrupted output run this long means the agent is busy (e.g. its "Working (12s)" timer). */
export const SUSTAIN_MS = 3000;
/** Ticks further apart than this mean the machine slept or the window was throttled. */
export const SUSPEND_MS = 10_000;
/** A hooked agent that is silent this long while "working" lost its Stop (killed subagent, crash). */
export const STALL_MS = 30_000;
/**
 * Silence net while Claude reported background tasks at its last Stop (it starts a new turn itself when they finish).
 * Short on purpose: after a restart Claude may still list tasks of the previous session as running.
 */
export const BG_STALL_MS = 4 * 60_000;
/** Silence after the user pressed Esc / Ctrl-C on a hooked, working agent. */
export const INTERRUPT_QUIET_MS = 4000;

/** Replies the terminal itself writes to the pty (focus reports, cursor/device reports, mouse) are not user input. */
export function isUserInput(data: string): boolean {
  // OSC/DCS replies end with BEL or ST, so a typed Alt+P / Alt+] (a bare ESC prefix) still counts.
  return !/^\x1b(?:\[(?:[IO]|\??[\d;]*[Rcn]|<[\d;]*[Mm]|M[\s\S]{3})|\][\s\S]*(?:\x07|\x1b\\)|P[\s\S]*\x1b\\)$/.test(data);
}

/**
 * Notify only for a real transition seen in this session: working -> waiting, or a live agent hook.
 * A hooked agent is judged by its hooks only: a silence-based "waiting" (lost Stop, background-task net, Esc) never alerts.
 */
export function shouldNotify(prev: CellStatus, next: CellStatus, cause: StatusCause, hooked = false): boolean {
  if (next !== 'waiting' || prev === 'waiting' || prev === 'exited') return false;
  if (hooked && cause !== 'hook') return false;
  return cause === 'hook' || prev === 'working';
}

export type HookResult = 'applied' | 'ignored';
/** What ended a "working" state on a tick: the plain / background / Esc silence net, or a plain heuristic quiet window. */
export type StallKind = 'plain' | 'bg' | 'interrupt' | 'heuristic';

export class StatusTracker {
  status: CellStatus = 'idle';
  lastCause: StatusCause = 'heuristic';
  /** Why the cell last became "waiting" (stays at the last value while working). */
  lastReason: StatusReason = 'done';
  /** Set by the last tick that moved the cell from working to waiting. */
  lastStallKind: StallKind | null = null;
  private lastInput = -Infinity;
  private lastFocus = -Infinity;
  private lastOutput = -Infinity;
  private lastTick = -Infinity;
  private activityStart = -Infinity;
  private interruptAt = -Infinity;
  private armed = false;
  private hooked = false;
  private turnObserved = false;
  private waitingFromNotify = false;
  private background = false;
  /** A Stop / StopFailure ended the turn; only a prompt, a background-mode Stop or a permission notification reopens it. */
  private turnEnded = false;

  constructor(private readonly quietMs = 2000) {}

  get isHooked(): boolean {
    return this.hooked;
  }

  /** Real user keystroke. `submitted` = it contained Enter. */
  input(now: number, submitted: boolean): void {
    if (this.status === 'exited') return;
    this.lastInput = now;
    if (submitted) {
      this.armed = true;
      this.turnObserved = true;
    }
    if (this.status !== 'waiting') return;
    if (this.hooked) {
      // Any key answers a permission prompt / question (digits, Esc, Enter); the silence net ends it if nothing follows.
      if (this.waitingFromNotify) {
        this.waitingFromNotify = false;
        this.lastOutput = now;
        this.set('working', 'heuristic');
      }
      // Waiting after Stop: UserPromptSubmit decides (an empty Enter must not fake work).
      return;
    }
    if (submitted) this.status = 'idle';
  }

  /**
   * Something the terminal itself wrote to the pty (focus-in / focus-out when the user clicks the cell, mouse reports):
   * not a keystroke, and the redraw it makes the agent do is not work.
   */
  terminalReply(now: number): void {
    if (this.status === 'exited') return;
    this.lastFocus = now;
  }

  /** Esc / Ctrl-C while a hooked agent works: Claude sends no Stop for an interrupt, so check for silence soon. */
  interrupt(now: number): void {
    if (this.status === 'working' && this.hooked && !this.background) this.interruptAt = now;
  }

  output(now: number): void {
    if (this.status === 'exited') return;
    // Keystroke echo / prompt redraw / focus redraw. A working agent's spinner must still count while the user types,
    // but a background-mode cell is idle at its prompt: everything it prints right after a key or a click is a redraw.
    const redraw = now - this.lastInput < ECHO_MS || now - this.lastFocus < FOCUS_ECHO_MS;
    if (redraw && (this.status !== 'working' || this.background)) return;
    if (now - this.lastOutput > GAP_MS) this.activityStart = now;
    this.lastOutput = now;
    // Hooks own the status, except to recover from a silence-based "waiting" that turned out premature.
    if (this.hooked && !(this.status === 'waiting' && this.lastCause === 'heuristic')) return;
    if (this.armed) {
      this.status = 'working';
      return;
    }
    // Recover from a premature "waiting" (pause or notification mid-turn): an agent that keeps
    // redrawing for SUSTAIN_MS is clearly still working. Needs a turn started in this session.
    if (this.turnObserved && now - this.activityStart >= SUSTAIN_MS) {
      this.set('working', 'heuristic');
      this.armed = true;
    }
  }

  hook(event: HookEvent, now: number, info?: HookInfo): HookResult {
    if (this.status === 'exited') return 'ignored';
    if (event === 'session') return this.sessionStart(now, info?.source);
    this.hooked = true;
    this.turnObserved = true;
    this.armed = false;
    if (event === 'busy') {
      // A parallel tool finishing must not hide a prompt that still needs the user.
      if (this.status === 'waiting' && this.waitingFromNotify) return 'ignored';
      // Late PostToolUse / SubagentStop that trail a Stop must not reopen the finished turn.
      if (this.turnEnded) return 'ignored';
    }
    this.waitingFromNotify = event === 'notify';
    this.lastOutput = now;
    if (event === 'prompt') this.interruptAt = -Infinity;
    if (event === 'stopbg') this.background = true;
    else if (event !== 'busy') this.background = false;
    if (event === 'prompt' || event === 'stopbg' || event === 'notify') this.turnEnded = false;
    else if (event === 'stop' || event === 'fail') this.turnEnded = true;
    if (event === 'prompt' || event === 'busy' || event === 'stopbg') this.set('working', 'hook');
    else this.set('waiting', 'hook', event === 'notify' ? 'attention' : event === 'fail' ? 'error' : 'done');
    return 'applied';
  }

  /**
   * SessionStart (startup / resume / clear / compact / fork): the previous conversation's background tasks are no
   * longer ours, so background mode ends. A cell that was only "working" for those tasks goes to waiting quietly
   * (no alert: the user switched conversations, nothing finished). A compaction happens mid-turn, so it keeps the status.
   */
  private sessionStart(now: number, source?: string): HookResult {
    const wasBackground = this.background;
    this.background = false;
    this.interruptAt = -Infinity;
    if (!wasBackground) return 'applied';
    if (source !== 'compact' && this.status === 'working') {
      this.waitingFromNotify = false;
      this.turnEnded = true;
      this.set('waiting', 'heuristic', 'done'); // silent: nothing finished, the conversation was switched
    } else {
      this.lastOutput = now; // the shorter silence net starts counting now
    }
    return 'applied';
  }

  /** Terminal notification (OSC 9 / bell). Ignored once precise hooks drive the status. */
  osc9(): void {
    if (this.status === 'exited' || this.hooked || !this.turnObserved) return;
    this.armed = false;
    this.set('waiting', 'heuristic');
  }

  exited(): void {
    this.status = 'exited';
    this.background = false;
  }

  reset(): void {
    this.status = 'idle';
    this.armed = false;
    this.hooked = false;
    this.turnObserved = false;
    this.waitingFromNotify = false;
    this.background = false;
    this.turnEnded = false;
    this.lastReason = 'done';
    this.lastStallKind = null;
    this.lastInput = this.lastFocus = this.lastOutput = this.activityStart = this.lastTick = this.interruptAt = -Infinity;
  }

  tick(now: number): CellStatus {
    // After sleep / throttled timers the silence is not the agent's: restart the quiet window.
    if (this.lastTick > -Infinity && now - this.lastTick > SUSPEND_MS) {
      if (this.lastOutput > -Infinity) this.lastOutput = now;
      if (this.interruptAt > -Infinity) this.interruptAt = now;
    }
    this.lastTick = now;
    if (this.status === 'working') {
      // Hooked agents get a long net (lost Stop, killed subagent) and a short one after Esc/Ctrl-C.
      const kind: StallKind = !this.hooked ? 'heuristic' : this.background ? 'bg' : this.interruptAt > -Infinity ? 'interrupt' : 'plain';
      const quiet = kind === 'heuristic' ? this.quietMs : kind === 'bg' ? BG_STALL_MS : kind === 'interrupt' ? INTERRUPT_QUIET_MS : STALL_MS;
      const since = this.hooked ? Math.max(this.lastOutput, this.interruptAt) : this.lastOutput;
      if (now - since >= quiet) {
        this.armed = false;
        this.background = false;
        this.interruptAt = -Infinity;
        this.lastStallKind = kind;
        this.set('waiting', 'heuristic');
      }
    }
    return this.status;
  }

  private set(status: CellStatus, cause: StatusCause, reason: StatusReason = 'done'): void {
    this.status = status;
    this.lastCause = cause;
    if (status === 'waiting') this.lastReason = reason;
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
