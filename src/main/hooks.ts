// Local endpoint for agent status hooks. Claude gets a per-cell settings file (passed with
// --settings, the user's own settings.json is untouched) whose hooks `curl` this server.
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { parseCodexNotify, type CodexNotice } from '../shared/codexHooks';
import { SESSION_ID } from '../shared/sessionTrack';
import type { HookEvent, HookInfo } from '../shared/status';

/** URL events: the status events plus SubagentStop, which reaches the tracker as a "subagent" busy hook, and Codex's notify. */
type HookUrlEvent = HookEvent | 'subagent' | 'codex';
const EVENTS: HookUrlEvent[] = ['prompt', 'stop', 'stopbg', 'notify', 'busy', 'fail', 'subagent', 'codex'];
/** Notification types that do not mean "the agent needs you now" (idle_prompt follows Stop, or fires mid-work). */
const IGNORED_NOTIFICATIONS = new Set(['idle_prompt', 'auth_success']);
const MAX_BODY = 16 * 1024;
/** The Stop / StopFailure payload carries last_assistant_message, so it may be much larger. */
const MAX_STOP_BODY = 512 * 1024;
/** Codex appends its whole notify payload (user and assistant messages) to the command line; one that big still means "turn done". */
const MAX_CODEX_BODY = 1024 * 1024;
const DEBUG_LOG_MAX = 256 * 1024;
const MAX_STATUS_STRINGS = 8;
const FINISHED_TASK = new Set(['completed', 'complete', 'done', 'finished', 'failed', 'error', 'killed', 'stopped', 'cancelled', 'canceled', 'exited', 'timeout']);
/** Documented StopFailure error codes. */
const FAILURE_CODES = new Set([
  'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
  'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown',
]);

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const p: unknown = JSON.parse(body);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Long-lived plumbing (a dev server started with run_in_background...) never means "the agent is still working". */
const PLUMBING_TASK = /shell|bash|command|monitor|process|server/i;

function isRunning(t: unknown): boolean {
  const status = (t as { status?: unknown } | null)?.status;
  return typeof status !== 'string' || !FINISHED_TASK.has(status.trim().toLowerCase());
}

/** A running task holds the cell "working" unless its type says shell-like plumbing; unknown or missing types hold (conservative). */
function holdsCell(t: unknown): boolean {
  if (!isRunning(t)) return false;
  const type = (t as { type?: unknown } | null)?.type;
  return typeof type !== 'string' || !PLUMBING_TASK.test(type);
}

/** Task types that keep a session busy for a long time: the documented `workflow` and the raw `local_workflow`. */
export const LONG_TASK = /workflow/i;

function isWorkflow(t: unknown): boolean {
  if (!isRunning(t)) return false;
  const type = (t as { type?: unknown } | null)?.type;
  return typeof type === 'string' && LONG_TASK.test(type);
}

/** True when a Stop payload lists a running background task of agent-like (or unknown) type; crons and shell tasks do not count. */
export function hasActiveBackgroundWork(body: string): boolean {
  const tasks = parseObject(body)?.background_tasks;
  return Array.isArray(tasks) && tasks.some(holdsCell);
}

/** Diagnostics for a Stop payload: task counts and the distinct status strings (never ids, names, commands or text). */
export function stopInfo(body: string): HookInfo {
  const tasks = parseObject(body)?.background_tasks;
  const continuation = parseObject(body)?.stop_hook_active === true;
  if (!Array.isArray(tasks)) return { tasks: 0, active: 0, statuses: [], types: [], continuation, workflows: 0, tasksUnknown: true };
  const statuses = new Set<string>();
  const types = new Set<string>();
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[^\w.-]/g, '').slice(0, 24) || '?' : '?');
  for (const t of tasks) {
    statuses.add(clean((t as { status?: unknown } | null)?.status));
    types.add(clean((t as { type?: unknown } | null)?.type));
  }
  return {
    tasks: tasks.length, active: tasks.filter(holdsCell).length,
    statuses: [...statuses].slice(0, MAX_STATUS_STRINGS), types: [...types].slice(0, MAX_STATUS_STRINGS), continuation,
    workflows: tasks.filter(isWorkflow).length,
  };
}

/** The StopFailure error code; anything not on the documented list (or malformed) is reported as "unknown". */
export function parseFailure(body: string): string {
  const error = parseObject(body)?.error;
  return typeof error === 'string' && FAILURE_CODES.has(error) ? error : 'unknown';
}

/** Opt-in diagnostics line for a Stop payload: key names plus each task's type and status only, never any text. */
export function stopDebugLine(cellId: string, body: string, now = new Date()): string {
  const p = parseObject(body);
  if (!p) return `${now.toISOString()} ${cellId} unparsable
`;
  const tasks = Array.isArray(p.background_tasks)
    ? p.background_tasks.map((t) => {
        const o = (t ?? {}) as { type?: unknown; status?: unknown; name?: unknown };
        const named = typeof o.name === 'string' && o.name ? '/named' : '';
        return `${typeof o.type === 'string' ? o.type.slice(0, 40) : '?'}/${typeof o.status === 'string' ? o.status.slice(0, 40) : '?'}${named}`;
      })
    : null;
  return `${now.toISOString()} ${cellId} keys=${Object.keys(p).join(',')} tasks=${tasks ? `[${tasks.join(' ')}]` : '?'} stop_hook_active=${p.stop_hook_active === true}
`;
}

const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);

/** Opt-in diagnostics line for StopFailure / SessionStart: the error code or the source, plus the payload's key names only. */
export function hookDebugLine(kind: 'fail' | 'session', cellId: string, body: string, now = new Date()): string {
  const p = parseObject(body);
  if (!p) return `${now.toISOString()} ${cellId} ${kind} unparsable\n`;
  const detail = kind === 'fail' ? `error=${parseFailure(body)}` : `source=${typeof p.source === 'string' && SESSION_SOURCES.has(p.source) ? p.source : '?'}`;
  return `${now.toISOString()} ${cellId} ${kind} ${detail} keys=${Object.keys(p).join(',')}\n`;
}

/** Appends a Stop / StopFailure / SessionStart diagnostics line to <dir>/hook-debug.log (restarted when it exceeds 256 KB). No-op when disabled. */
export function logStopDebug(enabled: boolean, dir: string, cellId: string, body: string, kind: 'stop' | 'fail' | 'session' = 'stop'): void {
  if (!enabled) return;
  try {
    const file = join(dir, 'hook-debug.log');
    mkdirSync(dir, { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch { /* no file yet */ }
    if (size > DEBUG_LOG_MAX) writeFileSync(file, '');
    appendFileSync(file, kind === 'stop' ? stopDebugLine(cellId, body) : hookDebugLine(kind, cellId, body));
  } catch { /* diagnostics are optional */ }
}
const CELL_ID = /^[\w-]{1,64}$/;

/** True when a Notification hook payload (JSON on stdin) is a real request for the user. */
export function isAttentionNotification(body: string): boolean {
  try {
    const type = (JSON.parse(body) as { notification_type?: unknown }).notification_type;
    return typeof type !== 'string' || !IGNORED_NOTIFICATIONS.has(type);
  } catch {
    return true; // unknown payload: err on the side of telling the user
  }
}

/** Extracts the conversation id from a SessionStart payload; null for anything malformed. Never logs the body. */
export function parseSessionStart(body: string): { sessionId: string; source: string | undefined } | null {
  try {
    const p = JSON.parse(body) as { session_id?: unknown; source?: unknown; agent_id?: unknown };
    if (p?.agent_id !== undefined && p.agent_id !== null) return null; // subagent / teammate context, not the cell's conversation
    if (typeof p?.session_id !== 'string' || !SESSION_ID.test(p.session_id)) return null;
    const source = typeof p.source === 'string' && SESSION_SOURCES.has(p.source) ? p.source : undefined;
    return { sessionId: p.session_id, source };
  } catch {
    return null;
  }
}

export class HookServer extends EventEmitter {
  readonly token = randomBytes(16).toString('hex');
  private server: Server | null = null;
  port = 0;
  /** Current spawn nonce per cell; hook URLs carry it. */
  private nonces = new Map<string, string>();
  /** Set (from MC_HOOK_DEBUG=1) to the user data dir to log Stop / StopFailure / SessionStart payload shapes. */
  debugDir: string | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const parts = (req.url ?? '').split('/').filter(Boolean); // h/<token>/<cellId>/<event>
      if (req.method !== 'POST' || parts[0] !== 'h' || parts[1] !== this.token) {
        res.writeHead(403).end();
        return;
      }
      let cellId = '';
      try {
        cellId = decodeURIComponent(parts[2] ?? '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      const event = parts[3] as HookUrlEvent;
      if (!CELL_ID.test(cellId)) {
        res.writeHead(400).end();
        return;
      }
      // Each spawn gets a fresh nonce: late requests of a killed process (or old-format URLs without one) are dropped.
      const current = this.nonces.get(cellId) === parts[4] && parts[4] !== undefined;
      let body = '';
      const bigPayload = event === 'stop' || event === 'fail' || event === 'codex';
      const maxBody = event === 'codex' ? MAX_CODEX_BODY : bigPayload ? MAX_STOP_BODY : MAX_BODY;
      req.setEncoding('utf8');
      let oversized = false;
      req.on('data', (chunk: string) => {
        if (oversized) return;
        body += chunk;
        if (body.length <= maxBody) return;
        // Only Stop / StopFailure may carry a large payload (last message). They must never be lost: an oversized one
        // counts as a plain Stop / an unknown failure; any other oversized request is dropped.
        oversized = true;
        body = '';
        if (!bigPayload) req.destroy();
      });
      req.on('end', () => {
        // 204 without a body: hook stdout would otherwise be fed back to Claude as context.
        res.writeHead(204).end();
        if (!cellId || !current) return;
        if (event === 'codex') {
          // An oversized payload (nothing parsed) still ends the turn, just without ids.
          const notice = oversized ? {} : parseCodexNotify(body);
          if (notice) this.emit('codex', cellId, notice satisfies CodexNotice);
          return;
        }
        if (event === 'session') {
          const parsed = parseSessionStart(body);
          if (parsed) {
            logStopDebug(!!this.debugDir, this.debugDir ?? '', cellId, body, 'session');
            this.emit('session', cellId, parsed.sessionId, parsed.source);
            // Separate from 'hook': it never changes the status by itself, it only ends background mode.
            this.emit('sessionstart', cellId, parsed.source);
          }
          return;
        }
        if (!EVENTS.includes(event)) return;
        if (event === 'notify' && !isAttentionNotification(body)) return;
        if (event === 'stop') {
          logStopDebug(!!this.debugDir, this.debugDir ?? '', cellId, body);
          this.emit('hook', cellId, hasActiveBackgroundWork(body) ? 'stopbg' : 'stop', stopInfo(body));
          return;
        }
        if (event === 'fail') {
          logStopDebug(!!this.debugDir, this.debugDir ?? '', cellId, body, 'fail');
          this.emit('hook', cellId, 'fail', { error: parseFailure(body) } satisfies HookInfo);
          return;
        }
        if (event === 'stopbg') return; // internal event, only derived from Stop
        if (event === 'subagent') {
          this.emit('hook', cellId, 'busy', { subagent: true } satisfies HookInfo);
          return;
        }
        this.emit('hook', cellId, event);
      });
    });
    this.server.requestTimeout = 5000;
    // A listen that fails (loopback blocked by security software) rejects instead of never settling.
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      const timer = setTimeout(() => { server.off('error', fail); reject(new Error('hook server did not start listening in time')); }, 10_000);
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => { clearTimeout(timer); server.off('error', fail); resolve(); });
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop(): void {
    this.server?.close();
  }

  /** Hook URL for the cell's current spawn (a nonce is created on first use). */
  url(cellId: string, event: HookUrlEvent): string {
    let nonce = this.nonces.get(cellId);
    if (!nonce) this.nonces.set(cellId, (nonce = randomBytes(8).toString('hex')));
    return `http://127.0.0.1:${this.port}/h/${this.token}/${encodeURIComponent(cellId)}/${event}/${nonce}`;
  }

  /** Hook URL a Codex process of the cell posts its notify payload to; a fresh nonce invalidates the previous process. */
  prepareCodex(cellId: string): string {
    this.nonces.set(cellId, randomBytes(8).toString('hex'));
    return this.url(cellId, 'codex');
  }

  /** Writes the per-cell Claude settings file and returns its path. */
  writeClaudeSettings(dir: string, cellId: string): string {
    mkdirSync(dir, { recursive: true });
    this.nonces.set(cellId, randomBytes(8).toString('hex')); // invalidates hooks of the previous process
    // Only Notification, Stop (background_tasks), StopFailure (error) and SessionStart need their payload (JSON on stdin); tool hooks would upload whole files.
    const withBody = new Set<HookUrlEvent>(['notify', 'stop', 'fail', 'session']);
    const hook = (event: HookUrlEvent) => [
      { hooks: [{ type: 'command', command: `curl -s -m 2 -X POST ${withBody.has(event) ? '--data-binary @- ' : ''}${this.url(cellId, event)}` }] },
    ];
    // PreToolUse/PostToolUse/SubagentStop mark "still busy": the agent keeps working after a Stop
    // that only ended a turn (background tasks) or after a permission prompt was answered.
    const settings = { hooks: {
      UserPromptSubmit: hook('prompt'), Stop: hook('stop'), Notification: hook('notify'),
      PreToolUse: hook('busy'), PostToolUse: hook('busy'), SubagentStop: hook('subagent'),
      // /resume and /clear start a different conversation; the payload carries its session_id.
      SessionStart: hook('session'),
      // A turn that ends with an API error (rate limit, billing, auth...) fires StopFailure, never Stop.
      StopFailure: hook('fail'),
    } };
    const path = join(dir, `claude-${cellId}.json`);
    writeFileSync(path, JSON.stringify(settings, null, 2));
    return path;
  }
}
