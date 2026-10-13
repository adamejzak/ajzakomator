// Real I/O for the CliDetector (kept apart so the detector itself stays pure and testable).
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { parseRegQueryPath } from '../shared/cliStatus';
import type { CliDetectorDeps, ExecOptions, ExecResult } from './cliDetect';

const OUTPUT_LIMIT = 256 * 1024;

/** Runs a program with stdin closed, a hard timeout and capped output; never rejects. */
export function runProgram(file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    let done = false;
    let child: ReturnType<typeof spawn>;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, stdout, timedOut });
    };
    try {
      child = spawn(file, args, {
        env: options.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: options.verbatim,
      });
    } catch {
      resolve({ ok: false, stdout: '', timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish(false);
    }, options.timeout);
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8'); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

/** Kills a process and everything it started (the install terminal's shell and its installer). */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    else process.kill(-pid, 'SIGKILL'); // the pty shell leads its own session and process group
  } catch { /* already gone */ }
}

/** Raw Machine / User PATH from the registry (REG_EXPAND_SZ stays unexpanded); chcp keeps non-ASCII folders intact. */
async function readRegistryPath(): Promise<{ machine: string | null; user: string | null } | null> {
  const query = async (key: string): Promise<string | null> => {
    const result = await runProgram('cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & reg query "${key}" /v Path""`], { timeout: 4000, env: process.env as Record<string, string>, verbatim: true });
    return result.ok ? parseRegQueryPath(result.stdout) : null;
  };
  const [machine, user] = await Promise.all([
    query('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    query('HKCU\\Environment'),
  ]);
  return machine === null && user === null ? null : { machine, user };
}

export function systemCliDeps(options: { disableRegistry?: boolean } = {}): CliDetectorDeps {
  return {
    platform: process.platform,
    home: homedir(),
    env: () => process.env,
    now: () => Date.now(),
    isFile: (path) => fs.stat(path).then((stat) => stat.isFile(), () => false),
    readDir: (path) => fs.readdir(path).catch(() => []),
    readFile: (path) => fs.readFile(path, 'utf8').then((text) => (text.length > 64 * 1024 ? null : text), () => null),
    exec: runProgram,
    // MC_CLI_NO_REGISTRY (unpackaged builds only) lets UI checks run against a sanitized PATH.
    readWindowsPath: process.platform === 'win32' && !options.disableRegistry ? readRegistryPath : undefined,
  };
}
