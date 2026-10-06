// Spawns and supervises the Pty Host utility process; restarts it if it crashes.
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { EventEmitter } from 'events';
import { join } from 'path';
import type { HostToMain, MainToHost, SpawnRequest } from '../shared/ipc';

export class PtyHostClient extends EventEmitter {
  private child: UtilityProcess | null = null;
  private shuttingDown = false;
  private renderer: WebContents | null = null;

  start(): void {
    const child = utilityProcess.fork(join(__dirname, 'ptyhost.js'), [], {
      serviceName: 'MultiCoding Pty Host',
      stdio: 'inherit',
    });
    this.child = child;
    child.on('message', (m: HostToMain) => this.emit('message', m));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.shuttingDown) return;
      this.emit('crashed', code);
      this.start();
      if (this.renderer && !this.renderer.isDestroyed()) this.connectRenderer(this.renderer);
    });
  }

  /** Gives the renderer a direct data channel to the host (call again after a renderer reload). */
  connectRenderer(wc: WebContents): void {
    this.renderer = wc;
    if (!this.child) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ t: 'port' }, [port1]);
    wc.postMessage('pty-port', null, [port2]);
  }

  private send(m: MainToHost): void {
    this.child?.postMessage(m);
  }

  spawn(req: SpawnRequest): void {
    this.send({ t: 'spawn', req });
  }

  kill(id: string): void {
    this.send({ t: 'kill', id });
  }

  /** Kills all terminals (waiting for ConPTY to wind down), then stops the host. */
  async shutdown(timeoutMs = 4000): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const onMsg = (m: HostToMain) => {
        if (m.t === 'killedAll') {
          clearTimeout(timer);
          resolve();
        }
      };
      child.on('message', onMsg);
      child.postMessage({ t: 'killAll' } satisfies MainToHost);
    });
    child.kill();
  }
}
