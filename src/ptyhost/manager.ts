// Owns every pseudo-terminal. Independent of Electron so it can be integration-tested in Node.
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import * as pty from 'node-pty';
import type { SpawnRequest } from '../shared/ipc';
import type { ShellKind } from '../shared/types';

export interface PtySink {
  data(id: string, data: string): void;
  exit(id: string, code: number): void;
}

const COALESCE_MS = 4;
const REPLAY_LIMIT = 512 * 1024;

interface Entry {
  proc: pty.IPty;
  buf: string;
  timer: NodeJS.Timeout | null;
  /** Tail of the output, replayed when a (reloaded) renderer reconnects. */
  history: string;
  exited: Promise<void>;
}

function onPath(exe: string, env: Record<string, string>): boolean {
  const path = env.PATH ?? env.Path ?? '';
  return path.split(delimiter).some((dir) => dir && existsSync(join(dir, exe)));
}

export function resolveShell(kind: ShellKind, env: Record<string, string>, platform = process.platform): { file: string; args: string[] } {
  if (platform !== 'win32') {
    const shell = kind === 'bash' || (platform !== 'darwin' && kind !== 'zsh') ? 'bash' : 'zsh';
    // Login shells load the PATH used by Homebrew and user-installed agent CLIs.
    return { file: `/bin/${shell}`, args: ['-il'] };
  }
  if (kind === 'cmd') return { file: 'cmd.exe', args: [] };
  if (kind === 'pwsh' && onPath('pwsh.exe', env)) return { file: 'pwsh.exe', args: ['-NoLogo'] };
  return { file: 'powershell.exe', args: ['-NoLogo'] };
}

export class PtyManager {
  private entries = new Map<string, Entry>();
  /** Sizes that arrived before their spawn request (the renderer's port is faster than main). */
  private earlySizes = new Map<string, { cols: number; rows: number }>();

  constructor(private sink: PtySink) {}

  setSink(sink: PtySink): void {
    this.sink = sink;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  spawn(req: SpawnRequest): number {
    if (this.entries.has(req.id)) this.kill(req.id);
    const { file, args } = resolveShell(req.shell, req.env);
    const size = this.earlySizes.get(req.id) ?? { cols: req.cols, rows: req.rows };
    this.earlySizes.delete(req.id);
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(2, size.cols),
      rows: Math.max(1, size.rows),
      cwd: req.cwd,
      env: { ...req.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'ajzakomator' },
      ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
    });
    let resolveExit!: () => void;
    const entry: Entry = { proc, buf: '', timer: null, history: '', exited: new Promise((r) => (resolveExit = r)) };
    this.entries.set(req.id, entry);

    let pendingCommand = req.command;
    proc.onData((data) => {
      if (this.entries.get(req.id) !== entry) return;
      entry.history = (entry.history + data).slice(-REPLAY_LIMIT);
      entry.buf += data;
      if (!entry.timer) entry.timer = setTimeout(() => this.flush(req.id, entry), COALESCE_MS);
      if (pendingCommand) {
        const cmd = pendingCommand;
        pendingCommand = undefined;
        // Give the shell a moment to finish drawing its prompt.
        setTimeout(() => this.entries.get(req.id) === entry && proc.write(cmd + '\r'), 150);
      }
    });
    proc.onExit(({ exitCode }) => {
      if (this.entries.get(req.id) === entry) {
        this.flush(req.id, entry);
        this.entries.delete(req.id);
        this.sink.exit(req.id, exitCode);
      }
      resolveExit();
    });
    return proc.pid;
  }

  private flush(id: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (!entry.buf) return;
    const out = entry.buf;
    entry.buf = '';
    this.sink.data(id, out);
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e) {
      this.earlySizes.set(id, { cols, rows });
      if (this.earlySizes.size > 200) this.earlySizes.delete(this.earlySizes.keys().next().value!);
      return;
    }
    try {
      e.proc.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      // resizing a pty that is exiting throws; harmless
    }
  }

  /** Output history of every live terminal (for a reconnecting renderer). */
  histories(): Array<{ id: string; data: string }> {
    return [...this.entries].map(([id, e]) => ({ id, data: e.history }));
  }

  /** Kills a terminal; resolves once it exited (bounded), so its cwd can be deleted afterwards. */
  kill(id: string, timeoutMs = 3000): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve();
    this.entries.delete(id);
    if (e.timer) clearTimeout(e.timer);
    try {
      e.proc.kill();
    } catch {
      // already gone
    }
    return Promise.race([e.exited, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  /** Kills every terminal and waits (bounded) for their exits — avoids ConPTY teardown crashes. */
  async killAll(timeoutMs = 3000): Promise<void> {
    const waits = [...this.entries.values()].map((e) => e.exited);
    for (const id of [...this.entries.keys()]) this.kill(id);
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}
