// Local endpoint for agent status hooks. Claude gets a per-cell settings file (passed with
// --settings, the user's own settings.json is untouched) whose hooks `curl` this server.
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import type { HookEvent } from '../shared/status';

const EVENTS: HookEvent[] = ['prompt', 'stop', 'notify', 'busy'];
/** Notification types that do not mean "the agent needs you now" (idle_prompt follows Stop, or fires mid-work). */
const IGNORED_NOTIFICATIONS = new Set(['idle_prompt', 'auth_success']);
const MAX_BODY = 16 * 1024;
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

export class HookServer extends EventEmitter {
  readonly token = randomBytes(16).toString('hex');
  private server: Server | null = null;
  port = 0;

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
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy(); // hooks never need more than the small notification payload
      });
      req.on('end', () => {
        // 204 without a body: hook stdout would otherwise be fed back to Claude as context.
        res.writeHead(204).end();
        if (!cellId || !EVENTS.includes(event)) return;
        if (event === 'notify' && !isAttentionNotification(body)) return;
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

  url(cellId: string, event: HookEvent): string {
    return `http://127.0.0.1:${this.port}/h/${this.token}/${encodeURIComponent(cellId)}/${event}`;
  }

  /** Writes the per-cell Claude settings file and returns its path. */
  writeClaudeSettings(dir: string, cellId: string): string {
    mkdirSync(dir, { recursive: true });
    // Only Notification needs its payload (JSON on stdin, for the type); tool hooks would upload whole files.
    const hook = (event: HookEvent) => [
      { hooks: [{ type: 'command', command: `curl -s -m 2 -X POST ${event === 'notify' ? '--data-binary @- ' : ''}${this.url(cellId, event)}` }] },
    ];
    // PreToolUse/PostToolUse/SubagentStop mark "still busy": the agent keeps working after a Stop
    // that only ended a turn (background tasks) or after a permission prompt was answered.
    const settings = { hooks: {
      UserPromptSubmit: hook('prompt'), Stop: hook('stop'), Notification: hook('notify'),
      PreToolUse: hook('busy'), PostToolUse: hook('busy'), SubagentStop: hook('busy'),
    } };
    const path = join(dir, `claude-${cellId}.json`);
    writeFileSync(path, JSON.stringify(settings, null, 2));
    return path;
  }
}
