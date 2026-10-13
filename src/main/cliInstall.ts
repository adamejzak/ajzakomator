// Guided install of Claude Code / Codex: runs the vendor's official command in a visible terminal (a pty typed
// into the configured shell, like the login window) and reports progress. The command is never taken from the
// renderer: it sends {cli, method}, which is validated against the allow-list in shared/cliStatus.ts.
import { randomUUID } from 'crypto';
import { posix, win32 } from 'path';
import {
  availableMethods, classifyInstallFailure, expectedBinDir, installCommandFor, INSTALL_PTY_PREFIX, isInstallMethod, NO_TOOLS,
  parseInstallMarker, parseToolProbe, shellFamily, toolProbeScript, typedInstallCommand,
  type InstallOptions, type InstallStartResult, type InstallState, type InstallTools,
} from '../shared/cliInstall';
import { isCliId, parseVersion, posixShellFile, type CliId, type CliStatus, type InstallMethod, type InstallPlatform } from '../shared/cliStatus';
import { cleanEnv } from '../shared/env';
import type { HostToMain } from '../shared/ipc';
import type { ShellKind } from '../shared/types';
import type { CliDetector, ExecOptions, ExecResult } from './cliDetect';

export interface InstallDeps {
  platform: NodeJS.Platform;
  home: string;
  shell(): ShellKind;
  env(): Record<string, string | undefined>;
  /** Same injected exec as the detector (stdin closed, timeout, capped output); only used to look for prerequisites. */
  exec(file: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  detector: Pick<CliDetector, 'get' | 'recheck' | 'applyEnv'>;
  /** Starts the typed command in a pty (output is tapped to `onHostMessage`); `env` is the complete environment. */
  spawnPty(spec: { id: string; command: string; env: Record<string, string> }): void;
  killPty(id: string): void;
  /** Kills the shell and everything it started (taskkill /T on Windows). */
  killTree?(pid: number): void;
  emit(state: InstallState): void;
  /** Unpackaged builds only (tests): the text typed instead of the official command. */
  commandOverride?(cli: CliId, method: InstallMethod): string | undefined;
  now?(): number;
  timeoutMs?: number;
  pollMs?: number;
  /** After the detector found the CLI while the command still runs: how long to wait for the command to return. */
  graceMs?: number;
  abortGraceMs?: number;
  toolsTtlMs?: number;
}

export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 5000;
const GRACE_MS = 20_000;
/** After Ctrl+C in the install terminal: how long the shell may still print the end marker before the run counts as aborted. */
const ABORT_GRACE_MS = 3000;
const TOOLS_TTL_MS = 30_000;
const TOOL_TIMEOUT_MS = 5000;
const OUTPUT_KEEP = 16 * 1024;

type Timer = ReturnType<typeof setTimeout>;

interface Session {
  id: string;
  ptyId: string;
  cli: CliId;
  method: InstallMethod;
  command: string;
  pid?: number;
  output: string;
  ended: boolean;
  finishing: boolean;
  polling: boolean;
  poll?: Timer;
  timeout?: Timer;
  grace?: Timer;
  abort?: Timer;
}

const installPlatform = (platform: NodeJS.Platform): InstallPlatform => (platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux');

export class InstallManager {
  private current: Session | null = null;
  private toolsCache?: { at: number; promise: Promise<InstallTools> };

  constructor(private readonly deps: InstallDeps) {}

  private get platform(): InstallPlatform { return installPlatform(this.deps.platform); }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  isActive(): boolean { return this.current !== null; }

  /** The running install (a window opened later attaches to it instead of being refused). */
  active(): { sessionId: string; ptyId: string; cli: CliId; method: InstallMethod; command: string } | null {
    const session = this.current;
    return session && !session.ended ? { sessionId: session.id, ptyId: session.ptyId, cli: session.cli, method: session.method, command: session.command } : null;
  }

  /** Methods that can work on this machine, each with the exact command that will be typed. Nothing runs here. */
  async options(cliValue: unknown): Promise<InstallOptions | null> {
    if (!isCliId(cliValue)) return null;
    const tools = await this.tools();
    const options = availableMethods(cliValue, this.platform, tools)
      .map((method) => ({ method, command: installCommandFor(cliValue, method, this.platform, this.deps.shell()) }))
      .filter((option): option is { method: InstallMethod; command: string } => option.command !== null);
    return { cli: cliValue, options, ...(tools.nodeVersion && options.some((option) => option.method === 'npm') ? { nodeVersion: tools.nodeVersion } : {}) };
  }

  async start(request: unknown): Promise<InstallStartResult> {
    const raw = typeof request === 'object' && request !== null && !Array.isArray(request) ? (request as { cli?: unknown; method?: unknown }) : null;
    const cli = raw?.cli;
    const method = raw?.method;
    if (!isCliId(cli) || !isInstallMethod(method)) return { ok: false, error: 'invalid' };
    const shell = this.deps.shell();
    const official = installCommandFor(cli, method, this.platform, shell);
    if (official === null) return { ok: false, error: 'invalid' };
    if (this.current) return { ok: false, error: 'busy' };

    const id = randomUUID();
    const session: Session = { id, ptyId: `${INSTALL_PTY_PREFIX}${id}`, cli, method, command: official, output: '', ended: false, finishing: false, polling: false };
    this.current = session; // claimed before the first await, so a second request is refused

    try {
      const tools = await this.tools();
      if (session.ended) return { ok: false, error: 'unavailable' };
      if (!availableMethods(cli, this.platform, tools).includes(method)) { this.end(session); return { ok: false, error: 'unavailable' }; }
      const text = this.deps.commandOverride?.(cli, method) || official;
      const typed = typedInstallCommand(text, shellFamily(shell, this.platform));
      const env = await this.deps.detector.applyEnv(cleanEnv(this.deps.env()));
      if (session.ended) return { ok: false, error: 'unavailable' };
      this.deps.spawnPty({ id: session.ptyId, command: typed, env });
    } catch {
      this.end(session);
      return { ok: false, error: 'spawn' };
    }

    session.poll = setInterval(() => void this.tick(session), this.deps.pollMs ?? POLL_MS);
    session.timeout = setTimeout(() => void this.complete(session, null, 'timeout'), this.deps.timeoutMs ?? INSTALL_TIMEOUT_MS);
    this.deps.emit({ sessionId: id, status: 'running' });
    return { ok: true, sessionId: id, ptyId: session.ptyId, command: official };
  }

  /** Messages of the pty host about an `install:` terminal. */
  onHostMessage(message: HostToMain): void {
    const session = this.current;
    if (!session || !('id' in message) || message.id !== session.ptyId || session.ended) return;
    if (message.t === 'spawned') session.pid = message.pid;
    else if (message.t === 'spawnError') this.fail(session, 'generic');
    else if (message.t === 'tap') {
      session.output = (session.output + message.data).slice(-OUTPUT_KEEP);
      if (session.finishing) return;
      const code = parseInstallMarker(session.output);
      if (code !== null) void this.complete(session, code, 'normal');
    } else if (message.t === 'interrupt') {
      // Ctrl+C aborts the rest of the typed line in PowerShell and POSIX shells, so the marker may never come.
      if (!session.finishing && !session.abort) session.abort = setTimeout(() => void this.complete(session, null, 'aborted'), this.deps.abortGraceMs ?? ABORT_GRACE_MS);
    } else if (message.t === 'exit' && !session.finishing) {
      // The shell itself ended (an installer called `exit`, or the user closed it): that is the command's result.
      void this.complete(session, parseInstallMarker(session.output) ?? message.code, 'normal');
    }
  }

  cancel(sessionId: unknown): void {
    const session = this.current;
    if (!session || session.id !== sessionId) return;
    this.end(session);
    this.kill(session);
  }

  /** The pty host died. */
  failActive(): void {
    const session = this.current;
    if (!session) return;
    this.fail(session, 'generic');
  }

  dispose(): void {
    const session = this.current;
    if (!session) return;
    this.end(session);
    this.kill(session);
  }

  // ── completion ─────────────────────────────────────────────────────────────

  /** Periodic early look: the CLI may be there before the typed command returned. */
  private async tick(session: Session): Promise<void> {
    if (session.ended || session.finishing || session.polling || session.grace) return;
    session.polling = true;
    let status: CliStatus | undefined;
    try { status = await this.deps.detector.get(session.cli, { force: true }); } catch { status = undefined; }
    session.polling = false;
    if (session.ended || session.finishing || session.grace) return;
    // A verified version means the binary runs; a half-written file is not announced as success.
    if (status?.state === 'found' && status.version) {
      session.grace = setTimeout(() => void this.complete(session, null, 'normal'), this.deps.graceMs ?? GRACE_MS);
    }
  }

  /** The command returned (marker, shell exit), the grace period after an early find ran out, or the time limit hit. */
  private async complete(session: Session, exitCode: number | null, mode: 'normal' | 'timeout' | 'aborted'): Promise<void> {
    if (session.ended || session.finishing) return;
    session.finishing = true;
    this.clearTimers(session);
    let status: CliStatus | undefined;
    try { status = (await this.deps.detector.recheck(session.cli))[session.cli]; } catch { status = undefined; }
    if (session.ended) return;
    if (status?.state === 'found') {
      const path = status.path;
      const dir = path ? (this.deps.platform === 'win32' ? win32 : posix).dirname(path) : undefined;
      this.finish(session, { sessionId: session.id, status: 'succeeded', ...(status.version ? { version: status.version } : {}), ...(path ? { path } : {}), ...(dir ? { dir } : {}) });
      return;
    }
    const reason = classifyInstallFailure({ exitCode, output: session.output, method: session.method, installedButMissing: exitCode === 0, timedOut: mode === 'timeout', aborted: mode === 'aborted' });
    this.fail(session, reason, exitCode ?? undefined);
  }

  private fail(session: Session, reason: Extract<InstallState, { status: 'failed' }>['reason'], exitCode?: number): void {
    const dir = reason === 'notOnPath' ? expectedBinDir(session.cli, session.method, this.platform, this.deps.home, this.deps.env()) : undefined;
    this.finish(session, { sessionId: session.id, status: 'failed', reason, ...(exitCode !== undefined ? { exitCode } : {}), ...(dir ? { dir } : {}) });
  }

  private finish(session: Session, state: InstallState): void {
    if (session.ended) return;
    this.end(session);
    this.kill(session); // the shell is idle at its prompt now; the terminal text stays visible in the window
    this.deps.emit(state);
  }

  private clearTimers(session: Session): void {
    if (session.poll) clearInterval(session.poll);
    if (session.timeout) clearTimeout(session.timeout);
    if (session.grace) clearTimeout(session.grace);
    if (session.abort) clearTimeout(session.abort);
    session.poll = session.timeout = session.grace = session.abort = undefined;
  }

  private end(session: Session): void {
    session.ended = true;
    this.clearTimers(session);
    if (this.current === session) this.current = null;
  }

  private kill(session: Session): void {
    try { if (session.pid !== undefined) this.deps.killTree?.(session.pid); } catch { /* already gone */ }
    try { this.deps.killPty(session.ptyId); } catch { /* the pty may already be gone */ }
  }

  // ── prerequisites ──────────────────────────────────────────────────────────

  private tools(): Promise<InstallTools> {
    const ttl = this.deps.toolsTtlMs ?? TOOLS_TTL_MS;
    if (this.toolsCache && this.now() - this.toolsCache.at <= ttl) return this.toolsCache.promise;
    const promise = this.probeTools().catch((): InstallTools => ({ ...NO_TOOLS, curl: this.deps.platform === 'darwin' }));
    this.toolsCache = { at: this.now(), promise };
    return promise;
  }

  /** Windows: `where` against the registry-refreshed PATH. POSIX: one login-shell probe (brew, nvm and friends live in the rc files). */
  private async probeTools(): Promise<InstallTools> {
    const env = cleanEnv(this.deps.env());
    if (this.deps.platform === 'win32') {
      const runEnv = await this.deps.detector.applyEnv(env);
      const has = (name: string) => this.deps.exec('where.exe', [name], { timeout: TOOL_TIMEOUT_MS, env: runEnv }).then((result) => result.ok, () => false);
      const [winget, npm, node] = await Promise.all([has('winget'), has('npm'), has('node')]);
      let nodeVersion: string | undefined;
      if (node) {
        const result = await this.deps.exec('node', ['--version'], { timeout: TOOL_TIMEOUT_MS, env: runEnv }).catch((): ExecResult => ({ ok: false, stdout: '', timedOut: false }));
        nodeVersion = parseVersion(result.stdout.replace(/^v/i, ''));
      }
      return { winget, brew: false, npm, node, curl: true, ...(nodeVersion ? { nodeVersion } : {}) };
    }
    // The shell cells (and this install) run in, so the PATH of its rc files is what counts.
    const shell = posixShellFile(this.deps.shell(), this.deps.platform);
    const script = toolProbeScript(shell);
    // macOS always ships curl; without a usable probe only the native installer is offered.
    const fallback: InstallTools = { ...NO_TOOLS, curl: this.deps.platform === 'darwin' };
    if (!script) return fallback;
    const result = await this.deps.exec(shell, ['-ilc', script], { timeout: TOOL_TIMEOUT_MS, env: { ...env, AJZAKOMATOR_PROBE: '1' } });
    return parseToolProbe(result.stdout) ?? fallback;
  }
}
