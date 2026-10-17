import { describe, expect, it } from 'vitest';
import { defaultShell, fullProjectPath, normalizeProjectPath, shellsForPlatform, shortcutLabel, WINDOWS_BUILD_ARG, windowsBuildFromArgv, windowsBuildFromRelease } from '../src/shared/platform';
import { defaultState, normalizeState } from '../src/shared/state';
import { resolveShell } from '../src/ptyhost/manager';

describe('platform support', () => {
  it('uses zsh on macOS and preserves Windows shell choices', () => {
    expect(defaultState('darwin').settings.shell).toBe('zsh');
    expect(defaultState('darwin').profiles.find((p) => p.cli === 'shell')!.name).toBe('Terminal');
    expect(defaultShell('win32')).toBe('pwsh');
    expect(shellsForPlatform('darwin').map((s) => s.code)).toEqual(['zsh', 'bash']);
    expect(shellsForPlatform('win32').map((s) => s.code)).toEqual(['pwsh', 'powershell', 'cmd']);
  });

  it('normalizes incompatible saved shell settings for the current platform', () => {
    expect(normalizeState(defaultState('win32'), 'darwin')!.settings.shell).toBe('zsh');
    expect(normalizeState(defaultState('darwin'), 'win32')!.settings.shell).toBe('pwsh');
    const mac = defaultState('darwin');
    mac.settings.shell = 'bash';
    expect(normalizeState(mac, 'darwin')!.settings.shell).toBe('bash');
  });

  it('runs macOS shells as interactive login shells for the agent PATH', () => {
    expect(resolveShell('zsh', {}, 'darwin')).toEqual({ file: '/bin/zsh', args: ['-il'] });
    expect(resolveShell('bash', {}, 'darwin')).toEqual({ file: '/bin/bash', args: ['-il'] });
    expect(resolveShell('cmd', {}, 'win32')).toEqual({ file: 'cmd.exe', args: [] });
  });

  it('uses native paths for file explorer actions', () => {
    expect(fullProjectPath('/Users/ala/My Project/', 'src/file.ts', 'darwin')).toBe('/Users/ala/My Project/src/file.ts');
    expect(fullProjectPath('D:\\My Project\\', 'src/file.ts', 'win32')).toBe('D:\\My Project\\src\\file.ts');
    expect(fullProjectPath('/Users/ala', '', 'darwin')).toBe('/Users/ala');
  });

  it('keeps Unix path case while comparing Windows paths without case', () => {
    expect(normalizeProjectPath('D:\\Projects\\App\\')).toBe(normalizeProjectPath('d:/projects/app'));
    expect(normalizeProjectPath('/Users/ala/App')).not.toBe(normalizeProjectPath('/Users/ala/app'));
  });

  it('displays Command and Option on macOS', () => {
    expect(shortcutLabel('darwin', 'Ctrl+Shift+G · Ctrl+Alt+Arrows')).toBe('Cmd+Shift+G · Cmd+Option+Arrows');
    expect(shortcutLabel('win32', 'Ctrl+K')).toBe('Ctrl+K');
  });

  it('passes the Windows build number to the sandboxed preload on the command line', () => {
    expect(windowsBuildFromRelease('win32', '10.0.26200')).toBe(26200);
    expect(windowsBuildFromRelease('win32', 'garbage')).toBe(0);
    expect(windowsBuildFromRelease('darwin', '24.1.0')).toBe(0);
    const argv = ['electron', '--type=renderer', `${WINDOWS_BUILD_ARG}${windowsBuildFromRelease('win32', '10.0.19045')}`];
    expect(windowsBuildFromArgv(argv)).toBe(19045);
    expect(windowsBuildFromArgv(['electron', `${WINDOWS_BUILD_ARG}0`])).toBe(0);
    expect(windowsBuildFromArgv(['electron', `${WINDOWS_BUILD_ARG}abc`])).toBe(0);
    expect(windowsBuildFromArgv(['electron'])).toBe(0);
  });
});
