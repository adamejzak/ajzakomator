import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { queueCodexMessage } from '../src/main/agentDelivery';

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
      expect(options.env.AJZ_TASK_MESSAGE).toBe(text);
      expect(options.env.AJZ_TARGET_SESSION).toBe('known-session');
      expect(args.at(-1)).toContain('catch { exit 1 }');
    } else expect(args).toEqual(['queue', '--thread', 'known-session', '--message', text]);
  });
  it('reports a queue failure without leaking prompts or credentials', async () => {
    vi.mocked(execFile).mockImplementation(((file: unknown, args: unknown, options: unknown, callback: (error: Error | null) => void) => { callback(new Error('failure containing secret')); }) as typeof execFile);
    await expect(queueCodexMessage('known-session', 'private prompt')).rejects.toThrow('item remains in the inbox');
    await expect(queueCodexMessage('known-session', 'private prompt')).rejects.not.toThrow('secret');
  });
});
