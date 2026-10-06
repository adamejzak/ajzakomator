import { describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/shared/env';
import { PtyManager } from '../src/ptyhost/manager';

function collect() {
  const out = new Map<string, string>();
  const exits = new Map<string, number>();
  const sink = {
    data: (id: string, d: string) => out.set(id, (out.get(id) ?? '') + d),
    exit: (id: string, code: number) => exits.set(id, code),
  };
  return { out, exits, sink };
}

async function waitFor(cond: () => boolean, ms = 15000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const env = cleanEnv(process.env);

describe('PtyManager (real ConPTY)', () => {
  it('runs the startup command in the given cwd and reports exit', async () => {
    const { out, exits, sink } = collect();
    const m = new PtyManager(sink);
    m.spawn({ id: 'a', cwd: process.cwd(), cols: 100, rows: 30, env, shell: 'pwsh', command: 'echo "mc-$((1+1))-ok"; (Get-Location).Path' });
    await waitFor(() => (out.get('a') ?? '').includes('mc-2-ok'));
    expect(out.get('a')).toContain('MULTICODING');
    m.resize('a', 80, 20);
    m.write('a', 'exit\r');
    await waitFor(() => exits.has('a'));
    expect(m.has('a')).toBe(false);
  });

  it('killAll resolves once all terminals are gone', async () => {
    const { sink } = collect();
    const m = new PtyManager(sink);
    m.spawn({ id: 'x', cwd: process.cwd(), cols: 80, rows: 24, env, shell: 'pwsh' });
    m.spawn({ id: 'y', cwd: process.cwd(), cols: 80, rows: 24, env, shell: 'cmd' });
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    await m.killAll(5000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(m.has('x') || m.has('y')).toBe(false);
  });

  it('keeps a replay history per terminal', async () => {
    const { out, sink } = collect();
    const m = new PtyManager(sink);
    m.spawn({ id: 'h', cwd: process.cwd(), cols: 80, rows: 24, env, shell: 'cmd', command: 'echo replay-me' });
    await waitFor(() => (out.get('h') ?? '').includes('replay-me'));
    expect(m.histories().find((h) => h.id === 'h')!.data).toContain('replay-me');
    await m.killAll();
  });
});
