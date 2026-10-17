import { describe, expect, it, vi } from 'vitest';
import { createCliHandlers } from '../src/main/cliIpc';
import { AutomationService } from '../src/main/automation';
import { StateController } from '../src/main/stateController';
import { addProject, defaultState } from '../src/shared/state';
import type { CliStatusMap } from '../src/shared/cliStatus';

const map: CliStatusMap = { claude: { cli: 'claude', state: 'missing', checkedAt: 1 } };

describe('cli IPC handlers', () => {
  const make = () => {
    const detector = { snapshot: vi.fn(() => map), recheck: vi.fn(async () => map) };
    const open = vi.fn();
    return { detector, open, handlers: createCliHandlers(detector, open) };
  };

  it('answers the status from the detector snapshot', () => {
    const { handlers } = make();
    expect(handlers.status()).toBe(map);
  });

  it('validates the CLI id of a recheck', async () => {
    const { handlers, detector } = make();
    await handlers.recheck();
    await handlers.recheck('codex');
    expect(detector.recheck.mock.calls).toEqual([[undefined], ['codex']]);
    for (const bad of ['shell', 'claude;calc', 42, {}, ['claude']]) await expect(handlers.recheck(bad)).rejects.toThrow('Unknown CLI');
    expect(detector.recheck).toHaveBeenCalledTimes(2);
  });

  it('shares a running recheck between repeated requests', async () => {
    let release!: () => void;
    const detector = { snapshot: vi.fn(() => map), recheck: vi.fn(() => new Promise<CliStatusMap>((resolve) => { release = () => resolve(map); })) };
    const handlers = createCliHandlers(detector, vi.fn());
    const a = handlers.recheck('claude');
    const b = handlers.recheck('claude');
    expect(a).toBe(b);
    release();
    await a;
    void handlers.recheck('claude');
    expect(detector.recheck).toHaveBeenCalledTimes(2);
  });

  it('opens only allow-listed documentation, never an address from the renderer', () => {
    const { handlers, open } = make();
    expect(handlers.openDocs('claude')).toBe(true);
    expect(handlers.openDocs('codex')).toBe(true);
    expect(open.mock.calls).toEqual([['https://code.claude.com/docs/en/setup'], ['https://github.com/openai/codex']]);
    for (const bad of ['https://evil.example', 'shell', undefined, 7, { toString: () => 'claude' }]) expect(handlers.openDocs(bad)).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe('create_grid with a missing CLI', () => {
  it('reports every cell that will not start, with a clear text, instead of pretending it started', async () => {
    const state = addProject(defaultState(), { name: 'P', path: 'D:/p' });
    const controller = new StateController(state, vi.fn());
    const startCells = vi.fn();
    const service = new AutomationService(controller, {
      createWorktree: vi.fn(), removeWorktree: vi.fn(), deliver: vi.fn(), startCells,
      missingCli: (profileId) => (profileId === 'claude' ? 'claude' : undefined),
    });
    const created = await service.execute('create_grid', { projectId: controller.get().projects[0].id, name: 'G', cells: [{ profileId: 'claude' }, { profileId: 'shell' }, { profileId: 'claude' }] }) as {
      gridId: string; cellIds: string[]; unavailable?: Array<{ cellId: string; cli: string; error: string }>;
    };
    expect(created.cellIds).toHaveLength(3);
    expect(created.unavailable?.map((u) => u.cellId)).toEqual([created.cellIds[0], created.cellIds[2]]);
    expect(created.unavailable?.[0]).toMatchObject({ cli: 'claude' });
    expect(created.unavailable?.[0].error).toContain('Claude Code is not installed');
    expect(service.statuses.get(created.cellIds[0])).toBe('exited');
    expect(service.statuses.get(created.cellIds[1])).toBeUndefined();
    expect(startCells).toHaveBeenCalledWith(created.cellIds);
  });

  it('keeps the plain result when nothing is missing', async () => {
    const controller = new StateController(addProject(defaultState(), { name: 'P', path: 'D:/p' }), vi.fn());
    const service = new AutomationService(controller, { createWorktree: vi.fn(), removeWorktree: vi.fn(), deliver: vi.fn(), startCells: vi.fn(), missingCli: () => undefined });
    const created = await service.execute('create_grid', { projectId: controller.get().projects[0].id, name: 'G', cells: [{ profileId: 'claude' }] });
    expect(Object.keys(created as object).sort()).toEqual(['cellIds', 'gridId']);
  });
});

describe('Codex delivery uses the detected binary', () => {
  it('passes the resolved command and PATH without changing how the message travels', async () => {
    const seen: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    vi.resetModules();
    vi.doMock('child_process', () => ({
      execFile: (file: string, args: string[], options: { env: Record<string, string> }, callback: (error: Error | null) => void) => { seen.push({ file, args, env: options.env }); callback(null); },
    }));
    const { queueCodexMessage: queue } = await import('../src/main/agentDelivery');
    await queue('s1', 'hello', { command: '/opt/x/codex', env: { PATH: '/opt/x:/usr/bin' } });
    expect(seen[0].env.PATH).toBe('/opt/x:/usr/bin');
    // Windows hands the message to PowerShell in the environment; elsewhere it is a plain argument of `codex queue`.
    if (process.platform === 'win32') expect(seen[0].env.UNIMUX_TASK_MESSAGE).toBe('hello');
    else {
      expect(seen[0].file).toBe('/opt/x/codex');
      expect(seen[0].args).toEqual(['queue', '--thread', 's1', '--message', 'hello']);
    }
  });
});
