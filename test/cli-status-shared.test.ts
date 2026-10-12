import { describe, expect, it } from 'vitest';
import {
  CLI_DOCS, cliForProfile, executableNames, expandWindowsVars, findEnvKey, installCommand, installMethods, isCliId, knownCliDirs,
  mergePaths, missingCli, missingClis, npmPrefixBinDir, parseRegQueryPath, parseShellProbe, parseVersion, prependDir,
  profileAvailable, registryPathEntries, shellProbeScript, sortVersionsDesc, spawnDecision, splitPath, versionedCliDirs, withPath,
  type CliStatus, type CliStatusMap,
} from '../src/shared/cliStatus';
import { cliMessages } from '../src/shared/cliMessages';

const status = (cli: 'claude' | 'codex', state: CliStatus['state']): CliStatus => ({ cli, state, checkedAt: 1 });

describe('profile -> CLI mapping and the spawn decision', () => {
  it('only agent profiles need a CLI', () => {
    expect(cliForProfile({ cli: 'claude' })).toBe('claude');
    expect(cliForProfile({ cli: 'codex' })).toBe('codex');
    expect(cliForProfile({ cli: 'shell' })).toBeNull();
    expect(isCliId('claude')).toBe(true);
    expect(isCliId('shell')).toBe(false);
    expect(isCliId(undefined)).toBe(false);
  });

  it('blocks a spawn only for a definite "missing" and fails open otherwise', () => {
    expect(spawnDecision({ cli: 'claude' }, status('claude', 'missing'))).toEqual({ spawn: false, cli: 'claude' });
    expect(spawnDecision({ cli: 'codex' }, status('codex', 'missing'))).toEqual({ spawn: false, cli: 'codex' });
    expect(spawnDecision({ cli: 'claude' }, status('claude', 'found'))).toEqual({ spawn: true });
    expect(spawnDecision({ cli: 'claude' }, status('claude', 'unknown'))).toEqual({ spawn: true });
    expect(spawnDecision({ cli: 'claude' }, undefined)).toEqual({ spawn: true });
    expect(spawnDecision({ cli: 'shell' }, status('claude', 'missing'))).toEqual({ spawn: true });
  });

  it('answers availability from the status map (unknown and not-yet-checked count as available)', () => {
    const map: CliStatusMap = { claude: status('claude', 'missing'), codex: status('codex', 'found') };
    expect(profileAvailable({ cli: 'claude' }, map)).toBe(false);
    expect(profileAvailable({ cli: 'codex' }, map)).toBe(true);
    expect(profileAvailable({ cli: 'shell' }, map)).toBe(true);
    expect(profileAvailable({ cli: 'claude' }, {})).toBe(true);
    expect(missingCli({ cli: 'claude' }, map)).toBe('claude');
    expect(missingClis([{ cli: 'claude' }, { cli: 'claude' }, { cli: 'codex' }, { cli: 'shell' }], map)).toEqual(['claude']);
  });
});

describe('official install data', () => {
  it('keeps the exact documented commands', () => {
    expect(installCommand('claude', 'darwin', 'native')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installCommand('claude', 'linux', 'native')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installCommand('claude', 'win32', 'native')).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(installCommand('claude', 'win32', 'npm')).toBe('npm install -g @anthropic-ai/claude-code');
    expect(installCommand('claude', 'darwin', 'brew')).toBe('brew install --cask claude-code');
    expect(installCommand('claude', 'win32', 'winget')).toBe('winget install Anthropic.ClaudeCode');
    expect(installCommand('codex', 'darwin', 'native')).toBe('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(installCommand('codex', 'win32', 'native')).toBe('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
    expect(installCommand('codex', 'linux', 'npm')).toBe('npm install -g @openai/codex');
    expect(installCommand('codex', 'darwin', 'brew')).toBe('brew install --cask codex');
  });

  it('offers a tool only where it exists', () => {
    expect(installCommand('claude', 'darwin', 'winget')).toBeNull();
    expect(installCommand('claude', 'win32', 'brew')).toBeNull();
    expect(installCommand('codex', 'win32', 'winget')).toBeNull();
    expect(installMethods('claude', 'win32')).toEqual(['native', 'npm', 'winget']);
    expect(installMethods('codex', 'darwin')).toEqual(['native', 'npm', 'brew']);
  });

  it('only documents https addresses and uses no em dashes anywhere', () => {
    expect(CLI_DOCS).toEqual({ claude: 'https://code.claude.com/docs/en/setup', codex: 'https://github.com/openai/codex' });
    const text = JSON.stringify([CLI_DOCS, cliMessages]);
    expect(text).not.toContain('\u2014');
    for (const cli of ['claude', 'codex'] as const) for (const platform of ['win32', 'darwin', 'linux'] as const) for (const method of ['native', 'npm', 'brew', 'winget'] as const) {
      expect(installCommand(cli, platform, method) ?? '').not.toContain('\u2014');
    }
  });
});

describe('PATH arithmetic', () => {
  it('splits per platform, ignoring empty entries and quotes', () => {
    expect(splitPath('C:\\a;"C:\\b c";;', 'win32')).toEqual(['C:\\a', 'C:\\b c']);
    expect(splitPath('/a:/b::', 'darwin')).toEqual(['/a', '/b']);
    expect(splitPath(undefined, 'linux')).toEqual([]);
  });

  it('merges without reordering and compares Windows entries case-insensitively', () => {
    expect(mergePaths(['C:\\Windows', 'C:\\Tools'], ['c:\\tools\\', 'C:\\New'], 'win32')).toEqual(['C:\\Windows', 'C:\\Tools', 'C:\\New']);
    expect(mergePaths(['/a'], ['/A', '/b'], 'linux')).toEqual(['/a', '/A', '/b']);
  });

  it('puts the CLI directory first only when it is missing from the PATH', () => {
    expect(prependDir(['/usr/bin', '/bin'], '/home/u/.local/bin', 'darwin')).toEqual(['/home/u/.local/bin', '/usr/bin', '/bin']);
    expect(prependDir(['/usr/bin', '/home/u/.local/bin'], '/home/u/.local/bin', 'darwin')).toEqual(['/usr/bin', '/home/u/.local/bin']);
  });

  it('writes PATH under the key the environment already uses', () => {
    expect(findEnvKey({ Path: 'x', Other: 'y' }, 'PATH', 'win32')).toBe('Path');
    expect(findEnvKey({ Path: 'x' }, 'PATH', 'linux')).toBeUndefined();
    expect(withPath({ Path: 'old', A: '1' }, 'new', 'win32')).toEqual({ Path: 'new', A: '1' });
    expect(withPath({ A: '1' }, 'new', 'darwin')).toEqual({ A: '1', PATH: 'new' });
  });

  it('expands registry values and orders Machine before User', () => {
    expect(expandWindowsVars('%USERPROFILE%\\.local\\bin;%Missing%', { userprofile: 'C:\\Users\\a' })).toBe('C:\\Users\\a\\.local\\bin;%Missing%');
    const entries = registryPathEntries(
      { machine: 'C:\\Windows;C:\\Windows\\System32', user: '%USERPROFILE%\\.local\\bin;C:\\windows;%UNKNOWN%\\x' },
      { USERPROFILE: 'C:\\Users\\a' },
    );
    expect(entries).toEqual(['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Users\\a\\.local\\bin']);
    expect(registryPathEntries({ machine: null, user: null }, {})).toEqual([]);
  });

  it('parses reg query output', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\x y\r\n\r\n';
    expect(parseRegQueryPath(out)).toBe('%USERPROFILE%\\.local\\bin;C:\\x y');
    expect(parseRegQueryPath('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });
});

describe('known locations and file names', () => {
  it('lists the documented macOS/Linux directories', () => {
    const dirs = knownCliDirs('darwin', {}, '/Users/a');
    for (const dir of ['/Users/a/.local/bin', '/Users/a/.claude/local', '/opt/homebrew/bin', '/usr/local/bin', '/Users/a/.npm-global/bin', '/Users/a/.bun/bin', '/Users/a/.volta/bin']) expect(dirs).toContain(dir);
    expect(versionedCliDirs('darwin', '/Users/a').map((v) => v.root)).toContain('/Users/a/.nvm/versions/node');
  });

  it('lists the Windows directories from the environment', () => {
    const dirs = knownCliDirs('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a');
    expect(dirs).toContain('C:\\Users\\a\\.local\\bin');
    expect(dirs).toContain('C:\\Users\\a\\AppData\\Roaming\\npm');
    expect(dirs).toContain('C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links');
    expect(dirs).toContain('C:\\Users\\a\\scoop\\shims');
  });

  it('uses PATHEXT on Windows (exe first) and the bare name elsewhere', () => {
    expect(executableNames('claude', 'win32', '.COM;.EXE;.BAT;.CMD;.VBS;.PS1')).toEqual(['claude.exe', 'claude.com', 'claude.bat', 'claude.cmd']);
    expect(executableNames('codex', 'win32')[0]).toBe('codex.exe');
    expect(executableNames('codex', 'darwin')).toEqual(['codex']);
  });

  it('sorts node versions newest first and reads the npm prefix', () => {
    expect(sortVersionsDesc(['v18.2.0', 'v20.10.1', 'v9.0.0', 'system'])).toEqual(['v20.10.1', 'v18.2.0', 'v9.0.0', 'system']);
    expect(npmPrefixBinDir('registry=x\nprefix=~/.npm-g\n', 'darwin', '/Users/a')).toBe('/Users/a/.npm-g/bin');
    expect(npmPrefixBinDir('prefix=C:\\npm', 'win32', 'C:\\Users\\a')).toBe('C:\\npm');
    expect(npmPrefixBinDir('prefix=${UNKNOWN}/x', 'darwin', '/Users/a')).toBeNull();
    expect(npmPrefixBinDir('nothing', 'darwin', '/Users/a')).toBeNull();
  });

  it('parses version output and nothing else', () => {
    expect(parseVersion('2.1.211 (Claude Code)')).toBe('2.1.211');
    expect(parseVersion('codex-cli 0.5.0\n')).toBe('0.5.0');
    expect(parseVersion('sk-ant-secret token')).toBeUndefined();
  });
});

describe('login shell probe', () => {
  it('builds a script for POSIX shells and fish, none for others', () => {
    expect(shellProbeScript('/bin/zsh')).toContain('__AJZ_PATH__');
    expect(shellProbeScript('/usr/local/bin/fish')).toContain('string join');
    expect(shellProbeScript('/usr/bin/nu')).toBeNull();
  });

  it('keeps only the marker lines and absolute paths', () => {
    const out = 'Welcome to my shell!\n\u001b[1mnoise\u001b[0m\n__AJZ_PATH__=/opt/homebrew/bin:/usr/bin:relative:/bin\n__AJZ_CLAUDE__=/Users/a/.local/bin/claude\n__AJZ_CODEX__=alias codex=foo\n';
    expect(parseShellProbe(out)).toEqual({ path: ['/opt/homebrew/bin', '/usr/bin', '/bin'], found: { claude: '/Users/a/.local/bin/claude' } });
    expect(parseShellProbe('nothing useful')).toEqual({ path: [], found: {} });
  });
});
