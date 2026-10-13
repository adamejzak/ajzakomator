// Codex status integration. Codex has no per-process hooks that need no trust review, but its `notify` setting runs a program
// with a JSON payload (appended as the last argument) when a turn completes successfully. We point it, per process and with
// `-c` only (the user's config.toml is never touched), at the local hook server through `curl`.
// Everything here is pure: the launch overrides, the payload parser and the thread-id bookkeeping of a cell.
import { SESSION_ID } from './sessionTrack';

/** Turn ids are opaque strings; only a conservative shape is accepted. */
const TURN_ID = /^[\w.:-]{1,128}$/;
/** What a hook URL of ours looks like; also guards the TOML value built from it against quote injection. */
const HOOK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/h\/[0-9a-f]{8,64}\/[\w%-]{1,200}\/codex\/[0-9a-f]{8,64}$/;

/** Notification types Codex raises as OSC 9 for our terminal: approvals and questions, never "turn complete" (notify does that). */
export const CODEX_ATTENTION_TYPES = ['approval-requested', 'plan-mode-prompt', 'async-question'] as const;

/** The `notify` argv: curl posts the JSON payload Codex appends as the final argument (`--data-raw` takes it verbatim). */
export function codexNotifyArgv(url: string): string[] {
  if (!HOOK_URL.test(url)) throw new Error('Invalid hook URL.');
  return ['curl', '-s', '--noproxy', '*', '-m', '2', url, '--data-raw'];
}

/**
 * The `key=value` overrides (values are TOML) for one Codex process. TOML literal strings (single quotes) are used so no
 * double quote ever reaches a shell: Windows PowerShell 5.1 would strip it from the argument.
 */
export function codexHookOverrides(url: string): string[] {
  const list = (items: readonly string[]) => `[${items.map((item) => `'${item}'`).join(',')}]`;
  return [
    `notify=${list(codexNotifyArgv(url))}`,
    `tui.notifications=${list(CODEX_ATTENTION_TYPES)}`,
    // Codex raises OSC 9 only while its terminal is unfocused by default; the app decides itself whether the user is looking.
    "tui.notification_condition='always'",
  ];
}

export interface CodexNotice {
  /** The conversation (thread) that finished a turn; absent when the payload carried none we trust. */
  threadId?: string;
  turnId?: string;
}

/** Whitelisting parser of the notify payload: a successful turn end, or null. Message texts and paths are never read. */
export function parseCodexNotify(body: string): CodexNotice | null {
  let p: unknown;
  try {
    p = JSON.parse(body);
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (o.type !== 'agent-turn-complete') return null;
  const notice: CodexNotice = {};
  if (typeof o['thread-id'] === 'string' && SESSION_ID.test(o['thread-id'])) notice.threadId = o['thread-id'].toLowerCase();
  if (typeof o['turn-id'] === 'string' && TURN_ID.test(o['turn-id'])) notice.turnId = o['turn-id'];
  return notice;
}

export interface ThreadVerdict {
  /** The event belongs to the cell's own conversation (and may drive its status). */
  own: boolean;
  /** The cell's stored session should become this thread. */
  bind: boolean;
}

/**
 * Which Codex thread a cell currently runs. The first thread a process reports (or the resumed one) is the cell's; a
 * different id may be a sub-agent finishing (it shares the notify setting) or a /new or /resume inside the process, so it
 * must repeat before it replaces the cell's thread.
 */
export class CodexThreads {
  private cells = new Map<string, { primary: string | null; candidate: string | null; seen: number }>();

  /** A new process for the cell; `resumeId` is the conversation it was started with. */
  begin(cellId: string, resumeId?: string): void {
    this.cells.set(cellId, { primary: resumeId && SESSION_ID.test(resumeId) ? resumeId.toLowerCase() : null, candidate: null, seen: 0 });
  }

  end(cellId: string): void {
    this.cells.delete(cellId);
  }

  primary(cellId: string): string | null {
    return this.cells.get(cellId)?.primary ?? null;
  }

  observe(cellId: string, threadId: string | undefined): ThreadVerdict {
    const c = this.cells.get(cellId);
    if (!c || !threadId) return { own: true, bind: false };
    const id = threadId.toLowerCase();
    if (c.primary === null) {
      c.primary = id;
      return { own: true, bind: true };
    }
    if (id === c.primary) {
      c.candidate = null;
      c.seen = 0;
      return { own: true, bind: false };
    }
    if (c.candidate === id) c.seen++;
    else { c.candidate = id; c.seen = 1; }
    if (c.seen < 2) return { own: false, bind: false };
    c.primary = id;
    c.candidate = null;
    c.seen = 0;
    return { own: true, bind: true };
  }
}

export interface CodexBindInput {
  known: boolean;
  isCodex: boolean;
  /** The cell's process runs (a late event of an old process must not win). */
  alive: boolean;
  currentId: string | undefined;
  currentConfirmed: boolean;
  reportedId: string;
}

/** True when the cell's stored session must become the reported thread (a different one, or the same one not yet confirmed). */
export function shouldBindCodexThread(i: CodexBindInput): boolean {
  return i.known && i.isCodex && i.alive && SESSION_ID.test(i.reportedId)
    && (i.currentId?.toLowerCase() !== i.reportedId.toLowerCase() || !i.currentConfirmed);
}

/** The session stored for a thread the live Codex reported itself: exact, so confirmed. */
export const codexThreadSession = (id: string) => ({ cli: 'codex' as const, id, confirmed: true });
