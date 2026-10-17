import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { codexQueueCall, queueCodexMessage } from '../src/main/agentDelivery';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
describe('native agent delivery', () => {
  it('passes untrusted message text as data, without interpolating it into shell source', async () => {
    const text = 'Review\n"quotes"; $(whoami) `whoami` & echo injected %PATH%';
    vi.mocked(execFile).mockImplementation(((file: unknown, args: unknown, options: unknown, callback: (error: Error | null) => void) => { callback(null); }) as typeof execFile);
    await queueCodexMessage('known-session', text);
    const [file, args, options] = vi.mocked(execFile).mock.calls.at(-1)! as unknown as [string, string[], { env: Record<string, string>; windowsHide: boolean }];
    expect(options.windowsHide).toBe(true);
    if (process.platform === 'win32') {
      expect(file).toBe('powershell.exe');
      expect(args.join(' ')).not.toContain(text);
      expect(options.env.UNIMUX_TASK_MESSAGE).toBe(text);
      expect(options.env.UNIMUX_TARGET_SESSION).toBe('known-session');
      expect(args.at(-1)).toContain('catch { exit 1 }');
    } else expect(args).toEqual(['queue', '--thread', 'known-session', '--message', text]);
  });
  it('starts a native codex.exe directly and reaches an npm shim through its PowerShell script with the policy bypassed', () => {
    const text = 'a "quoted" & message %PATH%';
    const exe = codexQueueCall('s1', text, { platform: 'win32', command: 'C:\\Users\\a\\.codex\\bin\\codex.exe', env: { Path: 'x' } });
    expect(exe).toEqual({ file: 'C:\\Users\\a\\.codex\\bin\\codex.exe', args: ['queue', '--thread', 's1', '--message', text], env: { Path: 'x' }, timeout: 10000 });

    const cmd = codexQueueCall('s1', text, { platform: 'win32', command: 'C:\\npm\\codex.cmd', env: {}, exists: (p) => p === 'C:\\npm\\codex.ps1' });
    expect(cmd.file).toBe('powershell.exe');
    expect(cmd.args).toEqual(expect.arrayContaining(['-ExecutionPolicy', 'Bypass']));
    expect(cmd.args.at(-1)).toContain('& $env:UNIMUX_CODEX_PATH queue');
    expect(cmd.args.join(' ')).not.toContain(text);
    expect(cmd.env).toMatchObject({ UNIMUX_CODEX_PATH: 'C:\\npm\\codex.ps1', UNIMUX_TASK_MESSAGE: text, UNIMUX_TARGET_SESSION: 's1' });

    // No script next to the shim (or nothing detected): the PATH lookup as before, never cmd.exe with the message.
    const unknown = codexQueueCall('s1', text, { platform: 'win32', command: 'C:\\npm\\codex.cmd', env: {}, exists: () => false });
    expect(unknown.args.at(-1)).toContain('& codex queue');
    expect(unknown.env.UNIMUX_CODEX_PATH).toBeUndefined();
    expect(codexQueueCall('s1', text, { platform: 'darwin', command: '/opt/codex', env: {} })).toMatchObject({ file: '/opt/codex', args: ['queue', '--thread', 's1', '--message', text] });
  });
  it('reports a queue failure without leaking prompts or credentials', async () => {
    vi.mocked(execFile).mockImplementation(((file: unknown, args: unknown, options: unknown, callback: (error: Error | null) => void) => { callback(new Error('failure containing secret')); }) as typeof execFile);
    await expect(queueCodexMessage('known-session', 'private prompt')).rejects.toThrow('item remains in the inbox');
    await expect(queueCodexMessage('known-session', 'private prompt')).rejects.not.toThrow('secret');
  });
});
