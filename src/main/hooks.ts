// Local endpoint for agent status hooks. Claude gets a per-cell settings file (passed with
// --settings, the user's own settings.json is untouched) whose hooks `curl` this server.
import { randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import type { HookEvent } from '../shared/status';

const EVENTS: HookEvent[] = ['prompt', 'stop', 'notify'];

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
      const [cellId, event] = [decodeURIComponent(parts[2] ?? ''), parts[3] as HookEvent];
      req.resume();
      // 204 without a body: hook stdout would otherwise be fed back to Claude as context.
      res.writeHead(204).end();
      if (cellId && EVENTS.includes(event)) this.emit('hook', cellId, event);
    });
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
    const hook = (event: HookEvent) => [
      { hooks: [{ type: 'command', command: `curl -s -m 2 -X POST ${this.url(cellId, event)}` }] },
    ];
    const settings = { hooks: { UserPromptSubmit: hook('prompt'), Stop: hook('stop'), Notification: hook('notify') } };
    const path = join(dir, `claude-${cellId}.json`);
    writeFileSync(path, JSON.stringify(settings, null, 2));
    return path;
  }
}
