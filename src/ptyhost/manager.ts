// Owns every pseudo-terminal. Independent of Electron so it can be integration-tested in Node.
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import * as pty from 'node-pty';
import type { SpawnRequest } from '../shared/ipc';
import type { ShellKind } from '../shared/types';
import { PTY_REPLAY_CHARS } from '../shared/terminalLimits';
import { coalesceDelay, FLUSH_NOW_CHARS, FlowGate, TailBuffer } from './flow';

export interface PtySink {
  /** Returns false when nobody received the data (no renderer connected). */
  data(id: string, data: string): unknown;
  exit(id: string, code: number): void;
}

/** A paused pty is resumed anyway when no acknowledgement arrives for this long (renderer gone or stuck). */
const PAUSE_WATCHDOG_MS = 3000;
/** How long the last output of a paused pty that exited may still arrive. */
const EXIT_DRAIN_MS = 80;

interface Entry {
  proc: pty.IPty;
  buf: string;
  timer: NodeJS.Timeout | null;
  /** Tail of the output, replayed when a (reloaded) renderer reconnects. */
  history: TailBuffer;
  gate: FlowGate;
  watchdog: NodeJS.Timeout | null;
  lastWrite: number;
  /** The process exited and its last output is being drained: never pause it again. */
  exiting: boolean;
  exited: Promise<void>;
}

/** Full path of `exe` in the PATH of `env` (the cell's PATH, which may be newer than this process's own); null when absent. */
function findOnPath(exe: string, env: Record<string, string>): string | null {
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return null;
}

export function resolveShell(kind: ShellKind, env: Record<string, string>, platform = process.platform): { file: string; args: string[] } {
  if (platform !== 'win32') {
    const shell = kind === 'bash' || (platform !== 'darwin' && kind !== 'zsh') ? 'bash' : 'zsh';
    // Login shells load the PATH used by Homebrew and user-installed agent CLIs.
    return { file: `/bin/${shell}`, args: ['-il'] };
  }
  if (kind === 'cmd') return { file: 'cmd.exe', args: [] };
  // An absolute path: node-pty resolves bare names only through this process's own (possibly stale) PATH.
  const pwsh = kind === 'pwsh' ? findOnPath('pwsh.exe', env) : null;
  if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
  return { file: 'powershell.exe', args: ['-NoLogo'] };
}

export class PtyManager {
  private entries = new Map<string, Entry>();
  /** Sizes that arrived before their spawn request (the renderer's port is faster than main). */
  private earlySizes = new Map<string, { cols: number; rows: number }>();
  /**
   * node-pty 1.1.0 on Windows removes a finished terminal from one shared list on a thread per terminal, without
   * a lock. Two terminals ending at the same moment corrupt it and trip a native assertion ("remove_pty_baton"),
   * which pops up an error dialog. Terminals are therefore killed one at a time, each after the previous exited.
   */
  private ending: Promise<void> = Promise.resolve();
  /** Back-pressure from the renderer (acks) is only active while a renderer is connected. */
  private flowControl = false;

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
      env: { ...req.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'unimux' },
      ...(process.platform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
    });
    let resolveExit!: () => void;
    const entry: Entry = { proc, buf: '', timer: null, history: new TailBuffer(PTY_REPLAY_CHARS), gate: new FlowGate(), watchdog: null, lastWrite: -Infinity, exiting: false, exited: new Promise((r) => (resolveExit = r)) };
    this.entries.set(req.id, entry);

    let pendingCommand = req.command;
    proc.onData((data) => {
      if (this.entries.get(req.id) !== entry) return;
      entry.history.push(data);
      entry.buf += data;
      if (entry.buf.length >= FLUSH_NOW_CHARS) this.flush(req.id, entry);
      else if (!entry.timer) entry.timer = setTimeout(() => this.flush(req.id, entry), coalesceDelay(Date.now(), entry.lastWrite));
      if (pendingCommand) {
        const cmd = pendingCommand;
        pendingCommand = undefined;
        // Give the shell a moment to finish drawing its prompt.
        setTimeout(() => this.entries.get(req.id) === entry && proc.write(cmd + '\r'), 150);
      }
    });
    proc.onExit(({ exitCode }) => {
      if (this.entries.get(req.id) !== entry) {
        resolveExit();
        return;
      }
      const finish = () => {
        if (this.entries.get(req.id) === entry) {
          this.flush(req.id, entry);
          this.entries.delete(req.id);
          this.sink.exit(req.id, exitCode);
        }
        resolveExit();
      };
      if (entry.gate.paused || entry.watchdog) {
        // A paused pty still holds unread output: let it drain before reporting the exit.
        entry.exiting = true;
        this.resume(entry);
        setTimeout(finish, EXIT_DRAIN_MS);
      } else {
        finish();
      }
    });
    return proc.pid;
  }

  private flush(id: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (!entry.buf) return;
    const out = entry.buf;
    entry.buf = '';
    const delivered = this.sink.data(id, out) !== false;
    if (delivered && this.flowControl && !entry.exiting && entry.gate.sent(out.length)) this.pause(entry);
  }

  private pause(entry: Entry): void {
    try {
      entry.proc.pause();
    } catch {
      // the pty is going away
    }
    if (entry.watchdog) clearTimeout(entry.watchdog);
    entry.watchdog = setTimeout(() => this.resume(entry, true), PAUSE_WATCHDOG_MS);
  }

  private resume(entry: Entry, force = false): void {
    if (entry.watchdog) clearTimeout(entry.watchdog);
    entry.watchdog = null;
    if (force) entry.gate.release();
    try {
      entry.proc.resume();
    } catch {
      // the pty is going away
    }
  }

  /** The renderer parsed `chars` characters of this terminal's output. */
  ack(id: string, chars: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.gate.acked(chars)) this.resume(e);
    else if (e.watchdog) {
      // Slow but alive: progress renews the watchdog.
      clearTimeout(e.watchdog);
      e.watchdog = setTimeout(() => this.resume(e, true), PAUSE_WATCHDOG_MS);
    }
  }

  /** Enables back-pressure for a freshly connected renderer; anything counted for the old one is forgotten. */
  setFlowControl(on: boolean): void {
    this.flowControl = on;
    for (const e of this.entries.values()) if (e.gate.reset() || e.watchdog) this.resume(e);
  }

  write(id: string, data: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.lastWrite = Date.now();
    e.proc.write(data);
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
    return [...this.entries].map(([id, e]) => ({ id, data: e.history.toString() }));
  }

  /** Kills a terminal; resolves once it exited (bounded), so its cwd can be deleted afterwards. */
  kill(id: string, timeoutMs = 3000): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return Promise.resolve();
    this.entries.delete(id);
    if (e.timer) clearTimeout(e.timer);
    if (e.watchdog) clearTimeout(e.watchdog);
    const turn = this.ending.then(() => {
      try {
        e.proc.kill();
      } catch {
        // already gone
      }
      return Promise.race([e.exited, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    });
    this.ending = turn.then(() => undefined, () => undefined);
    return turn;
  }

  /** Kills every terminal and waits (bounded) for their exits; they end one after another (see `ending`). */
  async killAll(timeoutMs = 3000): Promise<void> {
    const kills = [...this.entries.keys()].map((id) => this.kill(id));
    await Promise.race([Promise.all(kills), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}
