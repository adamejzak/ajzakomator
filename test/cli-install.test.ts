import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallState } from '../src/shared/cliInstall';
import type { CliId, CliStatus, CliStatusMap } from '../src/shared/cliStatus';
import type { HostToMain } from '../src/shared/ipc';
import type { ShellKind } from '../src/shared/types';
import { createInstallHandlers } from '../src/main/cliIpc';
import { InstallManager, type InstallDeps } from '../src/main/cliInstall';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const found = (cli: CliId, version = '2.1.0'): CliStatus => ({ cli, state: 'found', path: cli === 'claude' ? 'C:\\Users\\a\\.local\\bin\\claude.exe' : 'C:\\x\\codex.exe', version, checkedAt: 1 });
const missing = (cli: CliId): CliStatus => ({ cli, state: 'missing', reason: 'notOnPath', checkedAt: 1 });

interface Opts {
  platform?: NodeJS.Platform;
  shell?: ShellKind;
  where?: string[]; // Windows: tools `where.exe` finds
  nodeVersion?: string;
  probe?: string | null; // POSIX probe output; null = failing probe
  override?: string;
}

function setup(opts: Opts = {}, over: Partial<InstallDeps> = {}) {
  const platform = opts.platform ?? 'win32';
  const states: InstallState[] = [];
  const status: { value: CliStatus } = { value: missing('claude') };
  const spawned: Array<{ id: string; command: string; env: Record<string, string> }> = [];
  const detector = {
    get: vi.fn(async (cli: CliId) => ({ ...status.value, cli })),
    recheck: vi.fn(async (cli?: CliId): Promise<CliStatusMap> => ({ [cli ?? 'claude']: { ...status.value, cli: cli ?? 'claude' } })),
    applyEnv: vi.fn(async (env: Record<string, string>) => ({ ...env, PATH: `${env.PATH ?? ''};C:\\fresh` })),
  };
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === 'where.exe') return { ok: (opts.where ?? []).includes(args[0]), stdout: '', timedOut: false };
    if (file === 'node') return { ok: true, stdout: `v${opts.nodeVersion ?? '22.1.0'}\n`, timedOut: false };
    if (opts.probe === null) return { ok: false, stdout: '', timedOut: false };
    return { ok: true, stdout: opts.probe ?? '', timedOut: false };
  });
  const spawnPty = vi.fn((spec: { id: string; command: string; env: Record<string, string> }) => { spawned.push(spec); });
  const deps = {
    platform,
    home: platform === 'win32' ? 'C:\\Users\\a' : '/Users/a',
    shell: () => opts.shell ?? (platform === 'win32' ? 'powershell' : 'zsh'),
    env: () => ({ PATH: 'C:\\bin', SHELL: '/bin/zsh', APPDATA: 'C:\\Users\\a\\AppData\\Roaming', CLAUDECODE: '1' }),
    exec,
    detector,
    spawnPty,
    killPty: vi.fn(),
    killTree: vi.fn(),
    emit: vi.fn((state: InstallState) => { states.push(state); }),
    commandOverride: opts.override ? () => opts.override : undefined,
    ...over,
  } satisfies InstallDeps;
  const manager = new InstallManager(deps);
  const begin = async (cli: CliId = 'claude', method = 'native') => {
    const result = await manager.start({ cli, method });
    if (!result.ok) throw new Error(`start failed: ${result.error}`);
    return result;
  };
  const host = (message: HostToMain) => manager.onHostMessage(message);
  return { manager, deps, spawnPty, detector, exec, states, status, spawned, begin, host };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('InstallManager options', () => {
  it('lists only the methods that can work, with the exact command per shell', async () => {
    const h = setup({ where: ['winget', 'npm', 'node'], nodeVersion: '20.9.0' });
    const options = await h.manager.options('claude');
    expect(options).toEqual({
      cli: 'claude',
      options: [
        { method: 'native', command: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"' },
        { method: 'winget', command: 'winget install Anthropic.ClaudeCode' },
        { method: 'npm', command: 'npm.cmd install -g @anthropic-ai/claude-code' },
      ],
      nodeVersion: '20.9.0',
    });
    expect(h.spawned).toHaveLength(0); // nothing ran
    expect(h.deps.spawnPty).not.toHaveBeenCalled();
  });

  it('offers only the native installer when nothing else is detectable, and wraps it for cmd', async () => {
    const h = setup({ shell: 'cmd' });
    const options = await h.manager.options('claude');
    expect(options?.options).toEqual([{ method: 'native', command: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"' }]);
    expect(options?.nodeVersion).toBeUndefined();
  });

  it('probes the login shell once on POSIX and offers brew and npm from it', async () => {
    const probe = '__AJZ_TOOL_brew__=/opt/homebrew/bin/brew\n__AJZ_TOOL_npm__=/usr/local/bin/npm\n__AJZ_TOOL_node__=/usr/local/bin/node\n__AJZ_TOOL_curl__=/usr/bin/curl\n__AJZ_NODEV__=v22.2.0\n';
    const h = setup({ platform: 'darwin', probe });
    const options = await h.manager.options('claude');
    expect(options?.options.map((o) => o.method)).toEqual(['native', 'brew', 'npm']);
    expect(options?.options[1].command).toBe('brew install --cask claude-code');
    await h.manager.options('codex');
    expect(h.exec).toHaveBeenCalledTimes(1); // cached
    const [file, args] = h.exec.mock.calls[0];
    expect(file).toBe('/bin/zsh');
    expect(args[0]).toBe('-ilc');
  });

  it('falls back to the native installer on macOS and to nothing on Linux when the probe fails', async () => {
    expect((await setup({ platform: 'darwin', probe: null }).manager.options('codex'))?.options.map((o) => o.method)).toEqual(['native']);
    expect((await setup({ platform: 'linux', probe: null }).manager.options('codex'))?.options).toEqual([]);
  });

  it('refreshes the prerequisites after the cache expired', async () => {
    const h = setup({ where: [] }, { toolsTtlMs: 1000 });
    await h.manager.options('claude');
    const calls = h.exec.mock.calls.length;
    await h.manager.options('claude');
    expect(h.exec.mock.calls.length).toBe(calls);
    await vi.advanceTimersByTimeAsync(1500);
    await h.manager.options('claude');
    expect(h.exec.mock.calls.length).toBeGreaterThan(calls);
  });

  it('rejects an unknown CLI', async () => {
    const h = setup();
    for (const bad of ['shell', '__proto__', 42, null, undefined, {}]) expect(await h.manager.options(bad)).toBeNull();
  });
});

describe('InstallManager start validation (allow-list)', () => {
  it('refuses hostile and impossible requests without spawning anything', async () => {
    const h = setup({ where: ['winget'] });
    const bad: unknown[] = [
      null, undefined, 'claude', 42, [], [['claude', 'native']],
      {}, { cli: 'claude' }, { method: 'native' },
      { cli: 'claude;calc', method: 'native' }, { cli: '__proto__', method: 'native' }, { cli: 'constructor', method: 'native' },
      { cli: 'claude', method: 'native && calc' }, { cli: 'claude', method: '__proto__' }, { cli: 'claude', method: 'toString' },
      { cli: 'claude', method: ['native'] }, { cli: ['claude'], method: 'native' }, { cli: 'claude', method: 42 },
      { cli: 'claude', method: 'brew' }, // no Homebrew cask on Windows
      { cli: 'codex', method: 'winget' }, // no WinGet package for Codex
    ];
    for (const request of bad) expect(await h.manager.start(request)).toEqual({ ok: false, error: 'invalid' });
    expect(h.deps.spawnPty).not.toHaveBeenCalled();
    expect(h.manager.isActive()).toBe(false);
  });

  it('refuses a method whose prerequisite is missing', async () => {
    const h = setup({ where: [] }); // no winget, no npm
    expect(await h.manager.start({ cli: 'claude', method: 'winget' })).toEqual({ ok: false, error: 'unavailable' });
    expect(await h.manager.start({ cli: 'claude', method: 'npm' })).toEqual({ ok: false, error: 'unavailable' });
    expect(h.deps.spawnPty).not.toHaveBeenCalled();
    expect(h.manager.isActive()).toBe(false); // the claim is released
    expect((await h.manager.start({ cli: 'claude', method: 'native' })).ok).toBe(true);
  });

  it('ignores extra fields, so a renderer-supplied command is never used', async () => {
    const h = setup();
    await h.manager.start({ cli: 'claude', method: 'native', command: 'calc.exe', env: { X: '1' }, cwd: 'C:\\' });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].command).not.toContain('calc');
    expect(h.spawned[0].command).toContain('irm https://claude.ai/install.ps1 | iex"');
  });

  it('types the command with its end marker, in a clean environment with the refreshed PATH', async () => {
    const h = setup();
    const result = await h.begin();
    expect(result.ptyId).toMatch(/^install:/);
    expect(result.command).toBe('powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
    expect(h.spawned[0].id).toBe(result.ptyId);
    expect(h.spawned[0].command).toBe("powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm https://claude.ai/install.ps1 | iex\"; Write-Host ('__AJZ_DONE_' + '_' + [int](-not $?))");
    expect(h.spawned[0].env.PATH).toBe('C:\\bin;C:\\fresh');
    expect(h.spawned[0].env.CLAUDECODE).toBeUndefined();
    expect(h.states).toEqual([{ sessionId: result.sessionId, status: 'running' }]);
  });

  it('uses the shell-specific marker for cmd and POSIX shells', async () => {
    const cmd = setup({ shell: 'cmd' });
    await cmd.begin();
    expect(cmd.spawned[0].command).toMatch(/^powershell -NoProfile -ExecutionPolicy Bypass -Command ".*" && echo __AJZ_DON\^E__0 \|\| echo __AJZ_DON\^E__1$/);
    const posix = setup({ platform: 'darwin', probe: '__AJZ_TOOL_curl__=/usr/bin/curl\n' });
    await posix.begin('codex');
    expect(posix.spawned[0].command).toBe('(set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | sh); echo "__AJZ_DONE_""_$?"');
  });

  it('honours the unpackaged-build override for the typed text only', async () => {
    const h = setup({ override: 'powershell -File D:\\lab\\fake.ps1' });
    const result = await h.begin();
    expect(h.spawned[0].command.startsWith('powershell -File D:\\lab\\fake.ps1; Write-Host')).toBe(true);
    expect(result.command).toBe('powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
    expect(await h.manager.start({ cli: 'claude', method: 'bogus' })).toEqual({ ok: false, error: 'invalid' }); // validation still applies
  });

  it('reports a spawn failure and releases the claim', async () => {
    const h = setup();
    h.spawnPty.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(await h.manager.start({ cli: 'claude', method: 'native' })).toEqual({ ok: false, error: 'spawn' });
    expect(h.manager.isActive()).toBe(false);
    expect((await h.manager.start({ cli: 'claude', method: 'native' })).ok).toBe(true);
  });
});

describe('InstallManager completion', () => {
  it('succeeds when the marker arrives (split across chunks) and the detector finds the CLI', async () => {
    const h = setup();
    const { sessionId, ptyId } = await h.begin();
    h.host({ t: 'spawned', id: ptyId, pid: 4321 });
    h.host({ t: 'tap', id: ptyId, data: "PS C:\\Users\\a> irm https://claude.ai/install.ps1 | iex; Write-Host ('__AJZ_DONE_' + '_' + [int](-not $?))\r\n" });
    h.host({ t: 'tap', id: ptyId, data: 'Installing...\r\n__AJZ_DO' });
    await flush();
    expect(h.states).toHaveLength(1); // still running: neither the echo nor half a marker count
    h.status.value = found('claude', '2.1.211');
    h.host({ t: 'tap', id: ptyId, data: 'NE__0\r\n' });
    await flush();
    expect(h.detector.recheck).toHaveBeenCalledWith('claude');
    expect(h.states.at(-1)).toEqual({ sessionId, status: 'succeeded', version: '2.1.211', path: 'C:\\Users\\a\\.local\\bin\\claude.exe', dir: 'C:\\Users\\a\\.local\\bin' });
    expect(h.deps.killTree).toHaveBeenCalledWith(4321);
    expect(h.deps.killPty).toHaveBeenCalledWith(ptyId);
    expect(h.manager.isActive()).toBe(false);
  });

  it('fails with a mapped reason on a non-zero exit, even if the detector says missing', async () => {
    const h = setup();
    const { sessionId, ptyId } = await h.begin();
    h.host({ t: 'tap', id: ptyId, data: 'curl: (22) The requested URL returned error: 403\r\n__AJZ_DONE__22\r\n' });
    await flush();
    expect(h.states.at(-1)).toEqual({ sessionId, status: 'failed', reason: 'proxy', exitCode: 22 });
    expect(h.deps.killPty).toHaveBeenCalledWith(ptyId);
  });

  it('maps a PowerShell failure (marker 1) with network text', async () => {
    const h = setup();
    const { ptyId } = await h.begin();
    h.host({ t: 'tap', id: ptyId, data: 'Invoke-RestMethod : The remote name could not be resolved: \'claude.ai\'\r\n__AJZ_DONE__1\r\n' });
    await flush();
    expect(h.states.at(-1)).toMatchObject({ status: 'failed', reason: 'network', exitCode: 1 });
  });

  it('reports "installed but not on PATH" with the expected directory when the command exited cleanly', async () => {
    const h = setup();
    const { ptyId } = await h.begin();
    h.host({ t: 'tap', id: ptyId, data: 'Setup complete\r\n__AJZ_DONE__0\r\n' });
    await flush();
    expect(h.states.at(-1)).toMatchObject({ status: 'failed', reason: 'notOnPath', exitCode: 0, dir: 'C:\\Users\\a\\.local\\bin' });
  });

  it('treats the shell exiting on its own as the command result', async () => {
    const h = setup();
    const { ptyId } = await h.begin();
    h.host({ t: 'tap', id: ptyId, data: 'Access is denied\r\n' });
    h.host({ t: 'exit', id: ptyId, code: 1 });
    await flush();
    expect(h.states.at(-1)).toMatchObject({ status: 'failed', reason: 'permission', exitCode: 1 });
  });

  it('turns a spawn error of the host into a generic failure', async () => {
    const h = setup();
    const { ptyId } = await h.begin();
    h.host({ t: 'spawnError', id: ptyId, message: 'nope' });
    expect(h.states.at(-1)).toMatchObject({ status: 'failed', reason: 'generic' });
    expect(h.manager.isActive()).toBe(false);
  });

  it('times out after 10 minutes, kills the terminal and reports timeout', async () => {
    const h = setup();
    const { sessionId, ptyId } = await h.begin();
    h.host({ t: 'spawned', id: ptyId, pid: 9 });
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1000);
    expect(h.states).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.states.at(-1)).toEqual({ sessionId, status: 'failed', reason: 'timeout' });
    expect(h.deps.killTree).toHaveBeenCalledWith(9);
    expect(h.deps.killPty).toHaveBeenCalledWith(ptyId);
    expect(h.manager.isActive()).toBe(false);
  });

  it('succeeds at the time limit when the CLI is there after all', async () => {
    const h = setup({}, { pollMs: 10 * 60_000 * 2 });
    await h.begin();
    h.status.value = found('claude');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    expect(h.states.at(-1)?.status).toBe('succeeded');
  });

  it('cancel kills the process tree and the pty, emits nothing and ignores late output', async () => {
    const h = setup();
    const { sessionId, ptyId } = await h.begin();
    h.host({ t: 'spawned', id: ptyId, pid: 777 });
    h.manager.cancel('some-other-id');
    expect(h.deps.killPty).not.toHaveBeenCalled();
    h.manager.cancel(sessionId);
    expect(h.deps.killTree).toHaveBeenCalledWith(777);
    expect(h.deps.killPty).toHaveBeenCalledWith(ptyId);
    expect(h.manager.isActive()).toBe(false);
    h.status.value = found('claude');
    h.host({ t: 'tap', id: ptyId, data: '__AJZ_DONE__0\r\n' });
    h.host({ t: 'exit', id: ptyId, code: 0 });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(h.states).toHaveLength(1); // only "running"
    expect(h.detector.recheck).not.toHaveBeenCalled();
  });

  it('cancelling while the detector re-check runs drops the result', async () => {
    const h = setup();
    const { sessionId, ptyId } = await h.begin();
    let release!: () => void;
    h.detector.recheck.mockImplementationOnce(() => new Promise<CliStatusMap>((resolve) => { release = () => resolve({ claude: found('claude') }); }));
    h.host({ t: 'tap', id: ptyId, data: '__AJZ_DONE__0\r\n' });
    await flush();
    h.manager.cancel(sessionId);
    release();
    await flush();
    expect(h.states).toHaveLength(1);
  });

  it('allows only one install at a time and a new one after the first ended', async () => {
    const h = setup();
    const first = await h.begin();
    expect(await h.manager.start({ cli: 'codex', method: 'native' })).toEqual({ ok: false, error: 'busy' });
    expect(await h.manager.start({ cli: 'claude', method: 'native' })).toEqual({ ok: false, error: 'busy' });
    expect(h.spawned).toHaveLength(1);
    h.host({ t: 'tap', id: first.ptyId, data: '__AJZ_DONE__1\r\n' });
    await flush();
    expect((await h.manager.start({ cli: 'codex', method: 'native' })).ok).toBe(true);
    expect(h.spawned).toHaveLength(2);
  });

  it('refuses a concurrent start that arrives while prerequisites are still being probed', async () => {
    const h = setup();
    const [a, b] = await Promise.all([h.manager.start({ cli: 'claude', method: 'native' }), h.manager.start({ cli: 'claude', method: 'native' })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(h.spawned).toHaveLength(1);
  });

  it('ignores messages of other terminals and arriving without a session', async () => {
    const h = setup();
    h.host({ t: 'tap', id: 'install:nobody', data: '__AJZ_DONE__0\r\n' });
    const { ptyId } = await h.begin();
    h.host({ t: 'tap', id: 'abc-cell', data: '__AJZ_DONE__0\r\n' });
    h.host({ t: 'tap', id: ptyId.replace('install:', 'install:x'), data: '__AJZ_DONE__0\r\n' });
    h.host({ t: 'killedAll' });
    await flush();
    expect(h.states).toHaveLength(1);
    expect(h.detector.recheck).not.toHaveBeenCalled();
  });

  it('fails the active install when the pty host crashed', async () => {
    const h = setup();
    await h.begin();
    h.manager.failActive();
    expect(h.states.at(-1)).toMatchObject({ status: 'failed', reason: 'generic' });
    expect(h.manager.isActive()).toBe(false);
  });

  it('kills the terminal on dispose (window closed) without a state', async () => {
    const h = setup();
    const { ptyId } = await h.begin();
    h.host({ t: 'spawned', id: ptyId, pid: 5 });
    h.manager.dispose();
    expect(h.deps.killTree).toHaveBeenCalledWith(5);
    expect(h.deps.killPty).toHaveBeenCalledWith(ptyId);
    expect(h.states).toHaveLength(1);
  });
});

describe('InstallManager early detection', () => {
  it('finishes after a grace period when the detector sees a verified CLI but the command never returns', async () => {
    const h = setup({}, { pollMs: 1000, graceMs: 5000 });
    const { sessionId, ptyId } = await h.begin();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.states).toHaveLength(1); // not found yet
    h.status.value = found('claude', '2.1.9');
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.states).toHaveLength(1); // found, but the command may still be finishing
    await vi.advanceTimersByTimeAsync(5100);
    expect(h.states.at(-1)).toMatchObject({ sessionId, status: 'succeeded', version: '2.1.9' });
    expect(h.deps.killPty).toHaveBeenCalledWith(ptyId);
  });

  it('lets the marker win inside the grace period', async () => {
    const h = setup({}, { pollMs: 1000, graceMs: 5000 });
    const { ptyId } = await h.begin();
    h.status.value = found('claude', '2.1.9');
    await vi.advanceTimersByTimeAsync(1100);
    h.host({ t: 'tap', id: ptyId, data: '__AJZ_DONE__0\r\n' });
    await flush();
    expect(h.states.at(-1)?.status).toBe('succeeded');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.states.filter((s) => s.status === 'succeeded')).toHaveLength(1);
  });

  it('does not count a found binary without a verified version as early success', async () => {
    const h = setup({}, { pollMs: 1000, graceMs: 2000 });
    await h.begin();
    h.status.value = { ...found('claude'), version: undefined, reason: 'versionFailed' };
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.states).toHaveLength(1);
  });

  it('polls the detector without invalidating its caches', async () => {
    const h = setup({}, { pollMs: 1000 });
    await h.begin();
    await vi.advanceTimersByTimeAsync(3100);
    expect(h.detector.get).toHaveBeenCalledWith('claude', { force: true });
    expect(h.detector.recheck).not.toHaveBeenCalled();
  });
});

describe('install IPC handlers', () => {
  const make = () => {
    const manager = { options: vi.fn(async () => null), start: vi.fn(async () => ({ ok: false as const, error: 'invalid' as const })), cancel: vi.fn(), active: vi.fn(() => null) };
    return { manager, handlers: createInstallHandlers(manager) };
  };

  it('answers options only for a known CLI', async () => {
    const { manager, handlers } = make();
    for (const bad of ['shell', 'claude;calc', 7, null, undefined, {}, ['claude']]) expect(await handlers.options(bad)).toBeNull();
    expect(manager.options).not.toHaveBeenCalled();
    await handlers.options('codex');
    expect(manager.options).toHaveBeenCalledWith('codex');
  });

  it('forwards only cli and method of a start request', async () => {
    const { manager, handlers } = make();
    await handlers.start({ cli: 'claude', method: 'native', command: 'calc', env: { A: 'b' } });
    expect(manager.start).toHaveBeenCalledWith({ cli: 'claude', method: 'native' });
    for (const bad of [null, undefined, 'x', 3, []]) expect(await handlers.start(bad)).toEqual({ ok: false, error: 'invalid' });
    expect(manager.start).toHaveBeenCalledTimes(1);
  });

  it('cancels only with a string id', () => {
    const { manager, handlers } = make();
    handlers.cancel(5); handlers.cancel(null); handlers.cancel({}); handlers.cancel(undefined);
    expect(manager.cancel).not.toHaveBeenCalled();
    handlers.cancel('abc');
    expect(manager.cancel).toHaveBeenCalledWith('abc');
  });
});

describe('InstallManager Ctrl+C and attaching', () => {
  it('ends as aborted when the user hits Ctrl+C and no marker follows, instead of waiting 10 minutes', async () => {
    const h = setup({}, { abortGraceMs: 2000 });
    const { sessionId, ptyId } = await h.begin();
    h.host({ t: 'spawned', id: ptyId, pid: 11 });
    h.host({ t: 'tap', id: ptyId, data: 'Downloading...\r\n^C\r\nPS C:\\Users\\a> ' });
    h.host({ t: 'interrupt', id: ptyId });
    await vi.advanceTimersByTimeAsync(1900);
    expect(h.states).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.states.at(-1)).toEqual({ sessionId, status: 'failed', reason: 'aborted' });
    expect(h.deps.killTree).toHaveBeenCalledWith(11);
    expect(h.deps.killPty).toHaveBeenCalledWith(ptyId);
    expect(h.manager.isActive()).toBe(false);
  });

  it('lets a marker that still arrives after Ctrl+C decide (cmd keeps running the line)', async () => {
    const h = setup({ shell: 'cmd' }, { abortGraceMs: 2000 });
    const { ptyId } = await h.begin();
    h.host({ t: 'interrupt', id: ptyId });
    await vi.advanceTimersByTimeAsync(500);
    h.host({ t: 'tap', id: ptyId, data: '^C\r\n__AJZ_DONE__1\r\n' });
    await flush();
    expect(h.states.at(-1)).toMatchObject({ status: 'failed', reason: 'generic', exitCode: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.states.filter((s) => s.status === 'failed')).toHaveLength(1);
  });

  it('succeeds after Ctrl+C when the CLI turns out to be installed', async () => {
    const h = setup({}, { abortGraceMs: 1000 });
    const { ptyId } = await h.begin();
    h.status.value = found('claude');
    h.host({ t: 'interrupt', id: ptyId });
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.states.at(-1)?.status).toBe('succeeded');
  });

  it('ignores an interrupt of another terminal or without a session', async () => {
    const h = setup({}, { abortGraceMs: 100 });
    h.host({ t: 'interrupt', id: 'install:none' });
    await h.begin();
    h.host({ t: 'interrupt', id: 'install:other' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.states).toHaveLength(1);
  });

  it('does not finish on half of a multi-digit exit code', async () => {
    const h = setup();
    const { ptyId } = await h.begin();
    h.host({ t: 'tap', id: ptyId, data: 'curl: (22) The requested URL returned error: 403\r\n__AJZ_DONE__1' });
    await flush();
    expect(h.states).toHaveLength(1);
    h.host({ t: 'tap', id: ptyId, data: '30\r\n' });
    await flush();
    expect(h.states.at(-1)).toMatchObject({ status: 'failed', exitCode: 130 });
  });

  it('exposes the running install so a window opened later attaches to it', async () => {
    const h = setup();
    expect(h.manager.active()).toBeNull();
    const started = await h.begin();
    expect(h.manager.active()).toEqual({ sessionId: started.sessionId, ptyId: started.ptyId, cli: 'claude', method: 'native', command: started.command });
    h.manager.cancel(started.sessionId);
    expect(h.manager.active()).toBeNull();
  });

  it('probes the tools with the shell the cells run (settings.shell)', async () => {
    const probe = '__AJZ_TOOL_curl__=/usr/bin/curl\n';
    const h = setup({ platform: 'darwin', probe, shell: 'bash' });
    await h.manager.options('claude');
    expect(h.exec.mock.calls[0][0]).toBe('/bin/bash');
  });
});

describe('install IPC current', () => {
  it('answers with the manager\'s running install', () => {
    const active = { sessionId: 's', ptyId: 'install:s', cli: 'codex' as const, method: 'native' as const, command: 'x' };
    const handlers = createInstallHandlers({ options: vi.fn(), start: vi.fn(), cancel: vi.fn(), active: vi.fn(() => active) } as never);
    expect(handlers.current()).toBe(active);
  });
});
