// PtyManager.killAll: only terminals whose exit node-pty has not reported are tree-killed after the time limit; the pid of a
// terminal that already ended (killed or exited by itself) is never passed on, since it may belong to another program by now.
import { describe, expect, it, vi } from 'vitest';

interface FakePty { pid: number; exitWith(code: number): void; killed: boolean }
const ptys = vi.hoisted(() => ({ list: [] as unknown[], next: 100, exitOnKill: new Set<number>() }));
vi.mock('node-pty', () => ({
  spawn: () => {
    let onExit: ((e: { exitCode: number }) => void) | undefined;
    const pid = ptys.next++;
    const fake = {
      pid, killed: false,
      onData: () => ({ dispose() {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb; return { dispose() {} }; },
      write() {}, resize() {}, pause() {}, resume() {},
      kill() { fake.killed = true; if (ptys.exitOnKill.has(pid)) setTimeout(() => onExit?.({ exitCode: 0 }), 5); },
      exitWith(code: number) { onExit?.({ exitCode: code }); },
    };
    ptys.list.push(fake);
    return fake;
  },
}));

const { PtyManager } = await import('../src/ptyhost/manager');
const req = (id: string) => ({ id, cwd: '.', cols: 80, rows: 24, env: {}, shell: 'cmd' as const });
const flush = () => new Promise((r) => setTimeout(r, 30));

describe('PtyManager.killAll tree kill', () => {
  it('tree-kills only terminals that are still running after the limit', async () => {
    const treeKill = vi.fn();
    const m = new PtyManager({ data: () => true, exit: () => undefined }, treeKill);
    const exitedByItself = m.spawn(req('a'));
    const killedEarlier = m.spawn(req('b'));
    const endsOnKill = m.spawn(req('c'));
    const stuck = m.spawn(req('d'));
    const [a] = ptys.list as FakePty[];
    a.exitWith(0);
    ptys.exitOnKill.add(killedEarlier);
    ptys.exitOnKill.add(endsOnKill);
    await m.kill('b');
    await flush();
    await m.killAll(200);
    await flush();
    expect(treeKill.mock.calls.map((c) => c[0])).toEqual([stuck]);
    expect(treeKill).not.toHaveBeenCalledWith(exitedByItself);
    expect(treeKill).not.toHaveBeenCalledWith(killedEarlier);
    expect(treeKill).not.toHaveBeenCalledWith(endsOnKill);
  });

  it('tree-kills nothing when every terminal ended in time', async () => {
    const treeKill = vi.fn();
    const m = new PtyManager({ data: () => true, exit: () => undefined }, treeKill);
    ptys.exitOnKill.add(m.spawn(req('x')));
    ptys.exitOnKill.add(m.spawn(req('y')));
    await m.killAll(500);
    expect(treeKill).not.toHaveBeenCalled();
  });
});
