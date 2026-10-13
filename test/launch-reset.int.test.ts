// The reset typed around the CLI, run by REAL shells in a REAL pty: it must run whatever way the CLI ends.
import { existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/shared/env';
import { withResetTail } from '../src/shared/termReset';
import { PtyManager } from '../src/ptyhost/manager';
import type { ShellKind } from '../src/shared/types';

const windows = process.platform === 'win32';
const hasPowerShell = windows && existsSync(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
const env = cleanEnv(process.env);
/** The reset as a shell writes it (Windows shells never clear ?1004). */
const RESET = /\x1b\[\?1000;1002;1003;1005;1006;1015;(?:1004;)?2004l/;

async function waitFor(cond: () => boolean, ms: number, what: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Starts `shell`, types `line` (after optional setup lines), optionally sends Ctrl+C once the CLI runs, returns the output. */
async function typeLine(shell: ShellKind, line: string, opts: { setup?: string; ctrlCAfterMs?: number; until: () => RegExp; waitMs?: number }) {
  let out = '';
  const m = new PtyManager({ data: (_id, d) => ((out += d), true), exit: () => undefined });
  m.spawn({ id: 't', cwd: process.cwd(), cols: 160, rows: 30, env, shell, command: opts.setup ? `${opts.setup}\r${line}` : line });
  try {
    if (opts.ctrlCAfterMs) {
      await waitFor(() => out.includes('RUNNING'), 15000, 'CLI started');
      await new Promise((r) => setTimeout(r, opts.ctrlCAfterMs));
      out = '';
      m.write('t', '\x03');
    }
    await waitFor(() => opts.until().test(out), opts.waitMs ?? 15000, `pattern ${opts.until()} in ${JSON.stringify(out.slice(-300))}`);
    return out;
  } finally {
    await m.kill('t', 3000);
  }
}

// A marker the typed echo cannot contain (it is assembled by the shell). The typed echo of the line carries `[char]27+'[?1000;...` text, never a raw ESC right before `[?1000`, so RESET only matches the real write.
describe.skipIf(!hasPowerShell)('PowerShell launch line (real powershell.exe in ConPTY)', () => {
  const ps = (cli: string) => withResetTail(cli, 'powershell');

  it('runs the CLI with the same quoting inside try as outside, then resets', async () => {
    const cli = `node -p "process.argv.slice(1).join('|')" 'a b' 'it''s' "x y"`;
    const out = await typeLine('powershell', ps(cli), { until: () => RESET });
    expect(out).toContain("a b|it's|x y");
    expect(out.indexOf("a b|it's|x y")).toBeLessThan(out.search(RESET));
  }, 30000);

  it('resets after a real Ctrl+C of a long-running native command (a plain `; tail` is skipped)', async () => {
    const cli = `[Console]::Out.WriteLine('RUN'+'NING'); ping -n 25 127.0.0.1`;
    const t0 = Date.now();
    await typeLine('powershell', ps(cli), { ctrlCAfterMs: 1500, until: () => RESET, waitMs: 12000 });
    expect(Date.now() - t0).toBeLessThan(25000); // far sooner than the ping would have ended on its own
  }, 40000);

  it('resets after a non-zero exit', async () => {
    const out = await typeLine('powershell', ps('cmd /c exit 3'), { until: () => RESET });
    expect(out).toMatch(RESET);
  }, 30000);

  it('resets after a terminating error, also with $ErrorActionPreference = Stop', async () => {
    const out = await typeLine('powershell', ps('this-command-does-not-exist-xyz'), { setup: "$ErrorActionPreference = 'Stop'", until: () => RESET });
    expect(out).toMatch(RESET);
  }, 30000);
});

describe.skipIf(!hasPowerShell)('cmd launch line (real cmd.exe in ConPTY)', () => {
  const cmd = (cli: string) => withResetTail(cli, 'cmd');

  it('resets after a non-zero exit', async () => {
    const out = await typeLine('cmd', cmd('cmd /c exit 3'), { until: () => RESET });
    expect(out).toMatch(RESET);
  }, 30000);

  it('resets after Ctrl+C of a long-running command', async () => {
    const out = await typeLine('cmd', cmd('echo RUN^NING & ping -n 25 127.0.0.1'), { ctrlCAfterMs: 1500, until: () => RESET, waitMs: 12000 });
    expect(out).toMatch(RESET);
  }, 40000);
});

describe.skipIf(windows)('POSIX launch line (real bash)', () => {
  const sh = (cli: string) => withResetTail(cli, 'bash');

  it('resets after a failing command', async () => {
    expect(await typeLine('bash', sh('false'), { until: () => RESET })).toMatch(RESET);
  }, 30000);

  it('resets after Ctrl+C of a long-running command', async () => {
    const out = await typeLine('bash', sh("echo RUN''NING; sleep 25"), { ctrlCAfterMs: 1000, until: () => RESET, waitMs: 8000 });
    expect(out).toMatch(RESET);
  }, 40000);
});
