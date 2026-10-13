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

/** What the cell's stored session should become after a committed turn end. */
export interface BoundThread {
  id: string;
  /** Exact: the same thread ended turns at least twice. Only a confirmed session authorizes MCP delivery / restarts. */
  confirmed: boolean;
}

/**
 * Which Codex thread a cell runs. A notify names the thread that finished a turn, but sub-agents share the notify
 * setting, so a name alone proves nothing. The tracker therefore reports only turn ends that were followed by quiet
 * (`commit`); a thread that "finished" while the cell kept working is a sub-agent's (`markSecondary`) and is never bound.
 * The first committed thread is stored unconfirmed (enough for `codex resume`); the same thread committing a second time
 * confirms it; a different thread replaces a stored one only after committing twice without the stored one in between.
 */
export class CodexThreads {
  private primary: string | null = null;
  private confirmed = false;
  private commits = new Map<string, number>();
  private secondary = new Set<string>();

  /** A new process; `session` is the conversation the cell is stored with (the one it was resumed with). */
  begin(session?: { id: string; confirmed?: boolean }): void {
    const id = session && SESSION_ID.test(session.id) ? session.id.toLowerCase() : null;
    this.primary = id;
    this.confirmed = !!id && session?.confirmed === true;
    this.commits.clear();
    this.secondary.clear();
  }

  isSecondary(threadId: string): boolean {
    return this.secondary.has(threadId.toLowerCase());
  }

  /** Marks a thread as a sub-agent's; refuses (false) for the cell's own thread. */
  markSecondary(threadId: string): boolean {
    const id = threadId.toLowerCase();
    if (id === this.primary) return false;
    this.secondary.add(id);
    this.commits.delete(id);
    return true;
  }

  /** A turn end of `threadId` was committed. Returns the session to store, or null when nothing changes. */
  commit(threadId: string | undefined): BoundThread | null {
    if (!threadId) return null;
    const id = threadId.toLowerCase();
    if (this.secondary.has(id)) return null;
    const n = (this.commits.get(id) ?? 0) + 1;
    this.commits.set(id, n);
    if (this.primary === null) {
      this.primary = id;
      this.confirmed = false;
      return { id, confirmed: false };
    }
    if (id === this.primary) {
      for (const other of [...this.commits.keys()]) if (other !== id) this.commits.delete(other);
      if (!this.confirmed && n >= 2) {
        this.confirmed = true;
        return { id, confirmed: true };
      }
      return null;
    }
    if (n < 2) return null;
    this.primary = id;
    this.confirmed = true;
    this.commits.clear();
    return { id, confirmed: true };
  }
}
