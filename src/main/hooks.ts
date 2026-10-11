// Local endpoint for agent status hooks. Claude gets a per-cell settings file (passed with
// --settings, the user's own settings.json is untouched) whose hooks `curl` this server.
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { SESSION_ID } from '../shared/sessionTrack';
import type { HookEvent } from '../shared/status';

const EVENTS: HookEvent[] = ['prompt', 'stop', 'stopbg', 'notify', 'busy'];
/** Notification types that do not mean "the agent needs you now" (idle_prompt follows Stop, or fires mid-work). */
const IGNORED_NOTIFICATIONS = new Set(['idle_prompt', 'auth_success']);
const MAX_BODY = 16 * 1024;
/** The Stop payload carries last_assistant_message, so it may be much larger. */
const MAX_STOP_BODY = 512 * 1024;
const DEBUG_LOG_MAX = 256 * 1024;
const FINISHED_TASK = new Set(['completed', 'complete', 'done', 'finished', 'failed', 'error', 'killed', 'stopped', 'cancelled', 'canceled', 'exited', 'timeout']);

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const p: unknown = JSON.parse(body);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True when a Stop payload lists a background task that is not clearly finished (crons are not work in progress). */
export function hasActiveBackgroundWork(body: string): boolean {
  const tasks = parseObject(body)?.background_tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((t) => {
    const status = (t as { status?: unknown } | null)?.status;
    return typeof status !== 'string' || !FINISHED_TASK.has(status.trim().toLowerCase());
  });
}

/** Opt-in diagnostics line for a Stop payload: key names plus each task's type and status only, never any text. */
export function stopDebugLine(cellId: string, body: string, now = new Date()): string {
  const p = parseObject(body);
  if (!p) return `${now.toISOString()} ${cellId} unparsable
`;
  const tasks = Array.isArray(p.background_tasks)
    ? p.background_tasks.map((t) => {
        const o = (t ?? {}) as { type?: unknown; status?: unknown };
        return `${typeof o.type === 'string' ? o.type.slice(0, 40) : '?'}/${typeof o.status === 'string' ? o.status.slice(0, 40) : '?'}`;
      })
    : [];
  return `${now.toISOString()} ${cellId} keys=${Object.keys(p).join(',')} tasks=[${tasks.join(' ')}]
`;
}

/** Appends a Stop diagnostics line to <dir>/hook-debug.log (restarted when it exceeds 256 KB). No-op when disabled. */
export function logStopDebug(enabled: boolean, dir: string, cellId: string, body: string): void {
  if (!enabled) return;
  try {
    const file = join(dir, 'hook-debug.log');
    mkdirSync(dir, { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch { /* no file yet */ }
    if (size > DEBUG_LOG_MAX) writeFileSync(file, '');
    appendFileSync(file, stopDebugLine(cellId, body));
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

const SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork']);

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
  /** Set (from MC_HOOK_DEBUG=1) to the user data dir to log Stop payload shapes. */
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
      const event = parts[3] as HookEvent;
      if (!CELL_ID.test(cellId)) {
        res.writeHead(400).end();
        return;
      }
      // Each spawn gets a fresh nonce: late requests of a killed process (or old-format URLs without one) are dropped.
      const current = this.nonces.get(cellId) === parts[4] && parts[4] !== undefined;
      let body = '';
      const maxBody = event === 'stop' ? MAX_STOP_BODY : MAX_BODY;
      req.setEncoding('utf8');
      let oversized = false;
      req.on('data', (chunk: string) => {
        if (oversized) return;
        body += chunk;
        if (body.length <= maxBody) return;
        // Only Stop may carry a large payload (last message). A Stop must never be lost: an oversized one counts as a
        // plain Stop; any other oversized request is dropped.
        oversized = true;
        body = '';
        if (event !== 'stop') req.destroy();
      });
      req.on('end', () => {
        // 204 without a body: hook stdout would otherwise be fed back to Claude as context.
        res.writeHead(204).end();
        if (!cellId || !current) return;
        if ((event as string) === 'session') {
          const parsed = parseSessionStart(body);
          if (parsed) this.emit('session', cellId, parsed.sessionId, parsed.source);
          return;
        }
        if (!EVENTS.includes(event)) return;
        if (event === 'notify' && !isAttentionNotification(body)) return;
        if (event === 'stop') {
          logStopDebug(!!this.debugDir, this.debugDir ?? '', cellId, body);
          this.emit('hook', cellId, hasActiveBackgroundWork(body) ? 'stopbg' : 'stop');
          return;
        }
        if (event === 'stopbg') return; // internal event, only derived from Stop
        this.emit('hook', cellId, event);
      });
    });
    this.server.requestTimeout = 5000;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop(): void {
    this.server?.close();
  }

  /** Hook URL for the cell's current spawn (a nonce is created on first use). */
  url(cellId: string, event: HookEvent | 'session'): string {
    let nonce = this.nonces.get(cellId);
    if (!nonce) this.nonces.set(cellId, (nonce = randomBytes(8).toString('hex')));
    return `http://127.0.0.1:${this.port}/h/${this.token}/${encodeURIComponent(cellId)}/${event}/${nonce}`;
  }

  /** Writes the per-cell Claude settings file and returns its path. */
  writeClaudeSettings(dir: string, cellId: string): string {
    mkdirSync(dir, { recursive: true });
    this.nonces.set(cellId, randomBytes(8).toString('hex')); // invalidates hooks of the previous process
    // Only Notification, Stop (background_tasks) and SessionStart need their payload (JSON on stdin); tool hooks would upload whole files.
    const hook = (event: HookEvent | 'session') => [
      { hooks: [{ type: 'command', command: `curl -s -m 2 -X POST ${event === 'notify' || event === 'stop' || event === 'session' ? '--data-binary @- ' : ''}${this.url(cellId, event)}` }] },
    ];
    // PreToolUse/PostToolUse/SubagentStop mark "still busy": the agent keeps working after a Stop
    // that only ended a turn (background tasks) or after a permission prompt was answered.
    const settings = { hooks: {
      UserPromptSubmit: hook('prompt'), Stop: hook('stop'), Notification: hook('notify'),
      PreToolUse: hook('busy'), PostToolUse: hook('busy'), SubagentStop: hook('busy'),
      // /resume and /clear start a different conversation; the payload carries its session_id.
      SessionStart: hook('session'),
    } };
    const path = join(dir, `claude-${cellId}.json`);
    writeFileSync(path, JSON.stringify(settings, null, 2));
    return path;
  }
}
