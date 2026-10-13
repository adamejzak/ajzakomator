import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  availableMethods, childPowerShell, classifyInstallFailure, expectedBinDir, INSTALL_MARKER, installCommandFor, isAuxPtyId, isInstallMethod, nodeMajor,
  NO_TOOLS, parseInstallMarker, parseToolProbe, shellFamily, stripAnsi, toolProbeScript, typedInstallCommand, type InstallTools,
} from '../src/shared/cliInstall';
import { CLI_IDS } from '../src/shared/cliStatus';

const tools = (over: Partial<InstallTools> = {}): InstallTools => ({ ...NO_TOOLS, ...over });

describe('install methods per machine', () => {
  it('always offers the native installer on Windows, and only the prerequisites that exist', () => {
    expect(availableMethods('claude', 'win32', tools())).toEqual(['native']);
    expect(availableMethods('claude', 'win32', tools({ winget: true, npm: true, node: true }))).toEqual(['native', 'winget', 'npm']);
    expect(availableMethods('claude', 'win32', tools({ npm: true }))).toEqual(['native']); // npm needs node too
    expect(availableMethods('claude', 'win32', tools({ brew: true }))).toEqual(['native']);
  });

  it('offers WinGet for Claude only', () => {
    expect(availableMethods('codex', 'win32', tools({ winget: true }))).toEqual(['native']);
  });

  it('needs curl for the POSIX installers and brew only on macOS', () => {
    expect(availableMethods('codex', 'linux', tools())).toEqual([]);
    expect(availableMethods('codex', 'linux', tools({ curl: true, brew: true }))).toEqual(['native']);
    expect(availableMethods('claude', 'darwin', tools({ curl: true, brew: true, npm: true, node: true }))).toEqual(['native', 'brew', 'npm']);
    expect(availableMethods('claude', 'darwin', tools({ curl: true, winget: true }))).toEqual(['native']);
    expect(availableMethods('claude', 'darwin', tools({ brew: true }))).toEqual(['brew']);
  });

  it('never lists a combination that has no command', () => {
    for (const cli of CLI_IDS) for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const method of availableMethods(cli, platform, tools({ winget: true, brew: true, npm: true, node: true, curl: true }))) {
        expect(installCommandFor(cli, method, platform, platform === 'win32' ? 'powershell' : 'zsh')).not.toBeNull();
      }
    }
  });

  it('parses the Node.js major', () => {
    expect(nodeMajor('22.3.0')).toBe(22);
    expect(nodeMajor('v20.11.1')).toBe(20);
    expect(nodeMajor(undefined)).toBeUndefined();
    expect(nodeMajor('x')).toBeUndefined();
  });
});

describe('commands per shell', () => {
  it('runs the Claude iex in a child PowerShell for every Windows shell, and keeps the other documented commands', () => {
    const wrapped = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"';
    for (const shell of ['powershell', 'pwsh', 'cmd'] as const) expect(installCommandFor('claude', 'native', 'win32', shell)).toBe(wrapped);
    expect(installCommandFor('codex', 'native', 'win32', 'powershell')).toBe('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
    expect(installCommandFor('codex', 'native', 'win32', 'cmd')).toBe('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
    expect(installCommandFor('claude', 'winget', 'win32', 'cmd')).toBe('winget install Anthropic.ClaudeCode');
    expect(installCommandFor('claude', 'native', 'darwin', 'zsh')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  });

  it('runs npm through npm.cmd in PowerShell (npm.ps1 is blocked by the default execution policy)', () => {
    expect(installCommandFor('claude', 'npm', 'win32', 'powershell')).toBe('npm.cmd install -g @anthropic-ai/claude-code');
    expect(installCommandFor('codex', 'npm', 'win32', 'cmd')).toBe('npm install -g @openai/codex');
    expect(installCommandFor('codex', 'npm', 'darwin', 'zsh')).toBe('npm install -g @openai/codex');
  });

  it('returns null for impossible combinations and hostile values', () => {
    expect(installCommandFor('claude', 'brew', 'win32', 'powershell')).toBeNull();
    expect(installCommandFor('codex', 'winget', 'win32', 'powershell')).toBeNull();
    expect(installCommandFor('claude', 'winget', 'darwin', 'zsh')).toBeNull();
    for (const bad of ['', 'native; calc', '__proto__', 'constructor', 'toString']) {
      expect(isInstallMethod(bad)).toBe(false);
      expect(installCommandFor('claude', bad as never, 'win32', 'powershell')).toBeNull();
    }
    expect(installCommandFor('__proto__' as never, 'native', 'win32', 'powershell')).toBeNull();
  });

  it('never uses em dashes or elevation', () => {
    for (const cli of CLI_IDS) for (const platform of ['win32', 'darwin'] as const) for (const shell of ['powershell', 'cmd', 'zsh'] as const) {
      for (const method of ['native', 'npm', 'brew', 'winget'] as const) {
        const command = installCommandFor(cli, method, platform, shell);
        if (!command) continue;
        expect(command).not.toContain('\u2014');
        expect(command).not.toMatch(/sudo|Set-ExecutionPolicy|runas/i);
      }
    }
  });

  it('maps shells to families', () => {
    expect(shellFamily('cmd', 'win32')).toBe('cmd');
    expect(shellFamily('pwsh', 'win32')).toBe('powershell');
    expect(shellFamily('powershell', 'win32')).toBe('powershell');
    expect(shellFamily('cmd', 'darwin')).toBe('posix');
    expect(shellFamily('zsh', 'darwin')).toBe('posix');
  });
});

describe('end marker', () => {
  const families = ['powershell', 'cmd', 'posix'] as const;

  it('is not contained in the typed command, so the echo of the command never ends the install', () => {
    for (const family of families) {
      const typed = typedInstallCommand('some-installer --flag', family);
      expect(typed).not.toContain(INSTALL_MARKER);
      expect(parseInstallMarker(`PS C:\\Users\\x> ${typed}\r\n`)).toBeNull();
    }
  });

  it('parses the exit code, also across ANSI codes and chunk joins', () => {
    expect(parseInstallMarker(`done\r\n${INSTALL_MARKER}0\r\n`)).toBe(0);
    expect(parseInstallMarker(`\x1b[32m${INSTALL_MARKER}7\x1b[0m\r\n`)).toBe(7);
    expect(parseInstallMarker(`${INSTALL_MARKER}1 \r\n`)).toBe(1);
    expect(parseInstallMarker('__AJZ_DONE__')).toBeNull();
    expect(parseInstallMarker('__AJZ_DONE__x')).toBeNull();
    expect(parseInstallMarker('')).toBeNull();
    expect(parseInstallMarker('a'.repeat(100) + INSTALL_MARKER.slice(0, 5) + INSTALL_MARKER.slice(5) + '3\r\n')).toBe(3);
  });

  it('strips terminal escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07ok')).toBe('red ok');
  });

  it.skipIf(process.platform !== 'win32')('works in the real cmd.exe and PowerShell: success and failure', () => {
    const run = (file: string, args: string[]) => {
      try { return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { return String((error as { stdout?: string }).stdout ?? ''); }
    };
    const ps = (command: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', typedInstallCommand(command, 'powershell')]);
    expect(parseInstallMarker(ps('Write-Output ok'))).toBe(0);
    expect(parseInstallMarker(ps('cmd /c exit 3'))).toBe(1);
    expect(parseInstallMarker(ps('Write-Error boom'))).toBe(1);
    const cmd = (command: string) => run('cmd.exe', ['/d', '/s', '/c', typedInstallCommand(command, 'cmd')]);
    expect(parseInstallMarker(cmd('echo ok'))).toBe(0);
    expect(parseInstallMarker(cmd('cmd /c exit 3'))).toBe(1);
    // a pipeline with quotes, like the wrapped PowerShell form
    expect(parseInstallMarker(cmd('powershell -NoProfile -Command "Write-Output a | Out-Null"'))).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('works in a real POSIX shell, with pipefail', () => {
    const run = (command: string) => {
      try { return execFileSync('/bin/bash', ['-c', typedInstallCommand(command, 'posix')], { encoding: 'utf8' }); } catch (error) { return String((error as { stdout?: string }).stdout ?? ''); }
    };
    expect(parseInstallMarker(run('true'))).toBe(0);
    expect(parseInstallMarker(run('exit 7'))).toBe(7);
    expect(parseInstallMarker(run('false | true'))).toBe(1);
  });
});

describe('failure classification', () => {
  const classify = (output: string, over: Partial<Parameters<typeof classifyInstallFailure>[0]> = {}) => classifyInstallFailure({ exitCode: 1, output, method: 'native', ...over });

  it('maps the known failure texts', () => {
    expect(classify('curl: (6) Could not resolve host: claude.ai')).toBe('network');
    expect(classify('Invoke-RestMethod : Unable to connect to the remote server')).toBe('network');
    expect(classify('The underlying connection was closed: Could not establish trust relationship for the SSL/TLS secure channel.')).toBe('network');
    expect(classify('curl: (22) The requested URL returned error: 403')).toBe('proxy');
    expect(classify('<!DOCTYPE html><html><body>Blocked by policy</body></html>')).toBe('proxy');
    expect(classify('HTTP/1.1 407 Proxy Authentication Required')).toBe('proxy');
    expect(classify('EACCES: permission denied, mkdir \'/usr/local/lib/node_modules\'', { method: 'npm' })).toBe('permission');
    expect(classify('mkdir: cannot create directory: Permission denied')).toBe('permission');
    expect(classify("'npm' is not recognized as an internal or external command", { method: 'npm' })).toBe('npmMissing');
    expect(classify('zsh: command not found: npm', { method: 'npm' })).toBe('npmMissing');
    expect(classify("npm.cmd : The term 'npm.cmd' is not recognized as the name of a cmdlet", { method: 'npm' })).toBe('npmMissing');
    expect(classify('File C:\\x\\npm.ps1 cannot be loaded because running scripts is disabled on this system.', { method: 'npm' })).toBe('policy');
    expect(classify('PSSecurityException UnauthorizedAccess')).toBe('policy');
    expect(classify('something odd happened')).toBe('generic');
    expect(classify('')).toBe('generic');
  });

  it('reports installed-but-not-found only for a clean exit, and a timeout first', () => {
    expect(classify('all good', { exitCode: 0, installedButMissing: true })).toBe('notOnPath');
    expect(classify('boom', { exitCode: 1, installedButMissing: true })).toBe('generic');
    expect(classify('curl: (6)', { exitCode: null, timedOut: true })).toBe('timeout');
  });

  it('is not fooled by npm text for another method', () => {
    expect(classify("'npm' is not recognized", { method: 'native' })).toBe('generic');
  });
});

describe('expected directories', () => {
  it('knows where the documented methods put the binary', () => {
    expect(expectedBinDir('claude', 'native', 'win32', 'C:\\Users\\a', {})).toBe('C:\\Users\\a\\.local\\bin');
    expect(expectedBinDir('claude', 'native', 'darwin', '/Users/a', {})).toBe('/Users/a/.local/bin');
    expect(expectedBinDir('codex', 'native', 'darwin', '/Users/a', {})).toBeUndefined();
    expect(expectedBinDir('claude', 'npm', 'win32', 'C:\\Users\\a', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' })).toBe('C:\\Users\\a\\AppData\\Roaming\\npm');
    expect(expectedBinDir('claude', 'winget', 'win32', 'C:\\Users\\a', { LOCALAPPDATA: 'C:\\L' })).toBe('C:\\L\\Microsoft\\WinGet\\Links');
    expect(expectedBinDir('claude', 'brew', 'darwin', '/Users/a', {})).toBe('/opt/homebrew/bin');
  });
});

describe('POSIX tool probe', () => {
  it('builds a script only for supported shells', () => {
    expect(toolProbeScript('/bin/zsh')).toContain('command -v');
    expect(toolProbeScript('/usr/bin/fish')).toContain('command -v');
    expect(toolProbeScript('/bin/csh')).toBeNull();
  });

  it('parses markers, ignores rc noise and aliases', () => {
    const out = 'Welcome!\n__AJZ_TOOL_brew__=/opt/homebrew/bin/brew\n__AJZ_TOOL_npm__=\n__AJZ_TOOL_node__=/usr/bin/node\n__AJZ_TOOL_curl__=curl: aliased\n__AJZ_NODEV__=v22.4.1\n';
    expect(parseToolProbe(out)).toEqual({ winget: false, brew: true, npm: false, node: true, curl: false, nodeVersion: '22.4.1' });
    expect(parseToolProbe('nothing useful')).toBeNull();
  });
});

describe('auxiliary ptys', () => {
  it('treats login and install windows as non-cells', () => {
    expect(isAuxPtyId('auth:1')).toBe(true);
    expect(isAuxPtyId('install:abc')).toBe(true);
    expect(isAuxPtyId('3f2a')).toBe(false);
    expect(isAuxPtyId('my-install:x')).toBe(false);
  });
});

describe('real PowerShell: the vendor script must never swallow the end marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ajza-ps-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => { const path = join(dir, name); writeFileSync(path, body); return path; };
  // Like install.ps1: strict error preference, Write-Error and exit codes.
  const scripts = {
    stopWriteError: script('stop-write-error.ps1', "$ErrorActionPreference = 'Stop'\nWrite-Host 'downloading'\nWrite-Error 'Failed to download'\nexit 1\n"),
    stopExit: script('stop-exit.ps1', "$ErrorActionPreference = 'Stop'\nWrite-Host 'checking'\nexit 1\n"),
    thrown: script('thrown.ps1', "throw 'something went wrong'\n"),
    ok: script('ok.ps1', "$ErrorActionPreference = 'Stop'\nWrite-Host 'installed'\n"),
    okExit0: script('ok-exit0.ps1', "Write-Host 'installed'\nexit 0\n"),
  };
  const iexOf = (path: string) => `iex ([IO.File]::ReadAllText('${path}'))`;
  const run = (file: string, args: string[]): string => {
    const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return result.stdout ?? '';
  };
  const hasPwsh = process.platform === 'win32' && spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { stdio: 'ignore', windowsHide: true }).status === 0;
  const shells: Array<[string, string, boolean]> = [['Windows PowerShell 5.1', 'powershell.exe', process.platform === 'win32'], ['pwsh', 'pwsh', hasPwsh]];

  for (const [label, exe, available] of shells) {
    describe.skipIf(!available)(label, () => {
      const typed = (path: string) => typedInstallCommand(childPowerShell(iexOf(path)), 'powershell');
      const outcome = (path: string) => parseInstallMarker(run(exe, ['-NoProfile', '-NonInteractive', '-Command', typed(path)]));

      it('reports failure (1) for Write-Error with Stop, an exit 1 and a throw', () => {
        expect(outcome(scripts.stopWriteError)).toBe(1);
        expect(outcome(scripts.stopExit)).toBe(1);
        expect(outcome(scripts.thrown)).toBe(1);
      });

      it('reports success (0) for a script that succeeds', () => {
        expect(outcome(scripts.ok)).toBe(0);
        expect(outcome(scripts.okExit0)).toBe(0);
      });
    });
  }

  it.skipIf(process.platform !== 'win32')('shows why the iex must not run in the interactive shell itself (Stop aborts the marker)', () => {
    const bare = typedInstallCommand(iexOf(scripts.stopWriteError), 'powershell');
    expect(parseInstallMarker(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', bare]))).toBeNull();
  });

  it.skipIf(process.platform !== 'win32')('works from the real cmd.exe too (child PowerShell, && / || marker)', () => {
    const typed = (path: string) => typedInstallCommand(childPowerShell(iexOf(path)), 'cmd');
    // verbatim, like the interactive cmd.exe sees the typed line (node would re-escape the inner quotes)
    const outcome = (path: string) => parseInstallMarker(spawnSync('cmd.exe', ['/d', '/s', '/c', `"${typed(path)}"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).stdout ?? '');
    expect(outcome(scripts.stopWriteError)).toBe(1);
    expect(outcome(scripts.thrown)).toBe(1);
    expect(outcome(scripts.ok)).toBe(0);
  });
});
