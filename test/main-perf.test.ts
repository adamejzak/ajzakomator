// Main process work that must not block or repeat: hook commands, the editor lookup, existence checks, the accounts file and
// the registry PATH cache.
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeHookCommand, claudeHookSettings, HookServer } from '../src/main/hooks';
import { codexNotifyArgv } from '../src/shared/codexHooks';
import { createEditorFinder } from '../src/main/editor';
import { pathExists } from '../src/main/fsProbe';
import { AccountsStore } from '../src/main/accounts/store';
import { CliDetector, REGISTRY_TTL_MS } from '../src/main/cliDetect';

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'mc-mainperf-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Claude hook commands', () => {
  const url = (event: string) => `http://127.0.0.1:5000/h/abc/cell/${event}/n0nce`;
  type Hook = { type: string; command: string; async?: boolean };
  const hook = (settings: ReturnType<typeof claudeHookSettings>, name: string): Hook => (settings.hooks[name][0] as { hooks: Hook[] }).hooks[0];

  it('never go through a proxy, like the Codex notify hook', () => {
    expect(claudeHookCommand(url('stop'), true)).toBe("curl -s --noproxy '*' -m 2 -X POST --data-binary @- http://127.0.0.1:5000/h/abc/cell/stop/n0nce");
    expect(codexNotifyArgv('http://127.0.0.1:5000/h/abcdef01/cell/codex/abcdef01').slice(0, 4)).toEqual(['curl', '-s', '--noproxy', '*']);
    const settings = claudeHookSettings(url);
    for (const name of Object.keys(settings.hooks)) expect(hook(settings, name).command, name).toContain("--noproxy '*'");
  });

  it('run the busy hooks in the background and keep the status hooks synchronous with their payloads', () => {
    const settings = claudeHookSettings(url);
    for (const name of ['PreToolUse', 'PostToolUse', 'SubagentStop']) {
      expect(hook(settings, name).async, name).toBe(true);
      expect(hook(settings, name).command, name).not.toContain('--data-binary'); // tool payloads would upload whole files
    }
    for (const name of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart', 'StopFailure']) expect(hook(settings, name).async, name).toBeUndefined();
    for (const name of ['Stop', 'Notification', 'SessionStart', 'StopFailure']) expect(hook(settings, name).command, name).toContain('--data-binary @-');
    expect(hook(settings, 'PreToolUse').command).toContain('/busy/');
    expect(hook(settings, 'SubagentStop').command).toContain('/subagent/');
  });

  it('a failed listen rejects instead of throwing out of the process', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const server = new HookServer();
    // Force the listen onto an address that is taken.
    const original = (await import('http')).Server.prototype.listen;
    const port = (blocker.address() as { port: number }).port;
    (await import('http')).Server.prototype.listen = function (this: unknown, ...args: unknown[]) {
      return (original as (...a: unknown[]) => unknown).call(this, port, '127.0.0.1', ...(args.slice(2)));
    } as typeof original;
    try {
      await expect(server.start()).rejects.toThrow();
    } finally {
      (await import('http')).Server.prototype.listen = original;
      blocker.close();
      server.stop();
    }
  });
});

describe('editor lookup', () => {
  it('asks once per session for a found editor and again after a failed start or when none was found', async () => {
    const asked: string[] = [];
    let installed = new Set<string>();
    const finder = createEditorFinder(async (cmd) => { asked.push(cmd); return installed.has(cmd); });
    expect(await finder.find()).toBeNull();
    expect(asked).toEqual(['cursor', 'code']);
    installed = new Set(['code']);
    expect(await finder.find()).toBe('code');
    expect(await finder.find()).toBe('code');
    expect(asked).toEqual(['cursor', 'code', 'cursor', 'code']);
    finder.forget();
    installed = new Set(['cursor', 'code']);
    const [a, b] = await Promise.all([finder.find(), finder.find()]);
    expect([a, b]).toEqual(['cursor', 'cursor']);
    expect(asked.slice(4)).toEqual(['cursor']); // concurrent clicks share one lookup
  });
});

describe('pathExists', () => {
  it('answers without blocking and treats bad input as missing', async () => {
    const dir = temp();
    expect(await pathExists(dir)).toBe(true);
    expect(await pathExists(join(dir, 'nope'))).toBe(false);
    expect(await pathExists('')).toBe(false);
    expect(await pathExists('a\0b')).toBe(false);
  });
});

describe('accounts store cache', () => {
  it('reads the file again only when it changed, and own writes are seen at once', () => {
    const root = temp();
    const store = new AccountsStore(root);
    expect(store.list()).toEqual([]);
    store.commit({ id: '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091', addedAt: 1, email: 'a@b.c' });
    expect(store.list().map((a) => a.email)).toEqual(['a@b.c']);
    // A copy: editing what a caller got never changes the store.
    store.list()[0].email = 'changed@x.y';
    expect(store.get('3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091')?.email).toBe('a@b.c');
    // A change made outside (another size) is read.
    writeFileSync(join(root, 'accounts.json'), JSON.stringify({ version: 2, claude: [{ id: '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091', addedAt: 1, email: 'other@example.com' }] }));
    expect(store.list()[0].email).toBe('other@example.com');
  });
});

describe('registry PATH cache', () => {
  it('is reused for a minute, re-read after invalidateRegistry and a failed read is not kept', async () => {
    let clock = 1_000_000;
    let reads = 0;
    let answer: { machine: string | null; user: string | null } | null = { machine: 'C:\\Windows', user: null };
    const detector = new CliDetector({
      platform: 'win32', home: 'C:\\Users\\a', env: () => ({ Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a' }), now: () => clock,
      isFile: async () => false, readDir: async () => [], readFile: async () => null,
      exec: async () => ({ ok: true, stdout: '', timedOut: false }),
      readWindowsPath: async () => { reads++; return answer; },
    });
    await detector.applyEnv({ Path: 'C:\\Windows' });
    clock += REGISTRY_TTL_MS - 1;
    await detector.applyEnv({ Path: 'C:\\Windows' });
    expect(reads).toBe(1);
    detector.invalidateRegistry();
    await detector.applyEnv({ Path: 'C:\\Windows' });
    expect(reads).toBe(2);
    clock += REGISTRY_TTL_MS + 1;
    answer = null;
    await detector.applyEnv({ Path: 'C:\\Windows' });
    await Promise.resolve();
    await detector.applyEnv({ Path: 'C:\\Windows' });
    expect(reads).toBe(4); // the failed read was dropped right away
  });
});
