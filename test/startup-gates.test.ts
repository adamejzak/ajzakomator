import { describe, expect, it } from 'vitest';
import { createStartupGate, spawnWaitsFor } from '../src/main/startupGates';

const gates = () => ({ cellServices: createStartupGate(), accountsRecovered: createStartupGate() });
/** Whether all `waits` settle within a few ticks. */
const settles = async (waits: Promise<void>[]) => {
  let done = false;
  void Promise.all(waits).then(() => { done = true; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
};

describe('startup gates for cell spawns (0.9.4)', () => {
  it('a Claude cell waits for the hook/MCP servers and for the account recovery', async () => {
    const g = gates();
    const waits = spawnWaitsFor(g, { cli: 'claude' });
    expect(waits).toEqual([g.cellServices.promise, g.accountsRecovered.promise]);
    g.cellServices.open();
    expect(await settles(waits)).toBe(false);
    g.accountsRecovered.open();
    expect(await settles(waits)).toBe(true);
    expect(g.accountsRecovered.isOpen()).toBe(true);
  });

  it('a Codex cell waits for the servers only, never for the account recovery', async () => {
    const g = gates();
    const waits = spawnWaitsFor(g, { cli: 'codex' });
    expect(waits).toEqual([g.cellServices.promise]);
    g.cellServices.open();
    expect(await settles(waits)).toBe(true);
  });

  it('a plain shell (also an SSH cell) waits for nothing, unless it gets a startup prompt', () => {
    const g = gates();
    expect(spawnWaitsFor(g, { cli: 'shell' })).toEqual([]);
    expect(spawnWaitsFor(g, { cli: 'shell', startupPrompt: '  ' })).toEqual([]);
    expect(spawnWaitsFor(g, { cli: 'shell', startupPrompt: 'echo hi' })).toEqual([g.cellServices.promise]);
  });
});
