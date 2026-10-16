import { describe, expect, it, vi } from 'vitest';
import { HostRouter, type TerminalBackend } from '../src/ptyhost/router';

function backend(ids: string[]): TerminalBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    has: (id) => ids.includes(id),
    write: (id, d) => calls.push(`write ${id} ${d}`),
    resize: (id, c, r) => calls.push(`resize ${id} ${c}x${r}`),
    ack: (id, n) => calls.push(`ack ${id} ${n}`),
    setFlowControl: (on) => calls.push(`flow ${on}`),
    histories: () => ids.map((id) => ({ id, data: `h-${id}` })),
    kill: vi.fn(async (id: string) => { calls.push(`kill ${id}`); }),
    killAll: vi.fn(async () => { calls.push('killAll'); }),
  };
}

describe('HostRouter', () => {
  it('sends every call to the backend that owns the id', async () => {
    const pty = backend(['p']);
    const ssh = backend(['s']);
    const router = new HostRouter([pty, ssh]);
    router.write('s', 'ls'); router.ack('p', 5); router.resize('s', 90, 30);
    await router.kill('p');
    expect(pty.calls).toEqual(['ack p 5', 'kill p']);
    expect(ssh.calls).toEqual(['write s ls', 'resize s 90x30']);
    expect(router.histories()).toEqual([{ id: 'p', data: 'h-p' }, { id: 's', data: 'h-s' }]);
  });

  it('keeps sizes that arrive before the terminal exists (bounded) and hands them out once', () => {
    const router = new HostRouter([backend([])]);
    router.resize('new', 120, 40);
    expect(router.takeEarlySize('new')).toEqual({ cols: 120, rows: 40 });
    expect(router.takeEarlySize('new')).toBeUndefined();
    for (let i = 0; i < 250; i++) router.resize(`x${i}`, 80, 24);
    expect(router.takeEarlySize('x0')).toBeUndefined();
    expect(router.takeEarlySize('x249')).toEqual({ cols: 80, rows: 24 });
  });

  it('fans flow control and killAll out to every backend; unknown ids resolve', async () => {
    const a = backend([]); const b = backend([]);
    const router = new HostRouter([a, b]);
    router.setFlowControl(true);
    await router.killAll();
    await router.kill('nobody');
    expect(a.calls).toEqual(['flow true', 'killAll']);
    expect(b.calls).toEqual(['flow true', 'killAll']);
  });

  it('killAll waits for every backend even when one rejects', async () => {
    const a = backend([]); const b = backend([]);
    a.killAll = vi.fn(async () => { throw new Error('boom'); });
    let bDone = false;
    b.killAll = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); bDone = true; });
    await expect(new HostRouter([a, b]).killAll()).resolves.toBeUndefined();
    expect(bDone).toBe(true);
  });
});
