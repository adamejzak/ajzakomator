import { describe, expect, it } from 'vitest';
import type { SshHost, SshSessionState } from '../src/shared/ssh';
import { detailKey, hostTileState, liveDetail, menuHosts, newKeyDetail } from '../src/shared/sshView';

const host = (id: string, label: string, group?: string): SshHost => ({ id, label, address: `${label}.example`, port: 22, username: 'u', createdAt: 0, updatedAt: 0, ...(group ? { group } : {}) });
const session = (cellId: string, phase: SshSessionState['phase']): SshSessionState => ({ cellId, hostId: 'h1', phase, since: 0 });

describe('hostTileState', () => {
  it('shows the best state of the cells that run the host', () => {
    const cells = [{ id: 'c1', ssh: { hostId: 'h1' } }, { id: 'c2', ssh: { hostId: 'h1' } }, { id: 'c3' }];
    expect(hostTileState('h1', cells, {})).toBe('idle');
    expect(hostTileState('h1', cells, { c1: session('c1', 'error') })).toBe('error');
    expect(hostTileState('h1', cells, { c1: session('c1', 'error'), c2: session('c2', 'authenticating') })).toBe('connecting');
    expect(hostTileState('h1', cells, { c1: session('c1', 'connected'), c2: session('c2', 'error') })).toBe('connected');
    expect(hostTileState('h2', cells, { c1: session('c1', 'connected') })).toBe('idle');
  });
});

describe('details pane', () => {
  it('forgets a deleted host or key and keys a pane by what it shows', () => {
    expect(liveDetail({ kind: 'host', hostId: 'gone' }, [host('h1', 'a')], [])).toBeNull();
    expect(liveDetail({ kind: 'host' }, [], [])).toEqual({ kind: 'host' });
    expect(liveDetail({ kind: 'key', keyId: 'k' }, [], ['k'])).toEqual({ kind: 'key', keyId: 'k' });
    expect(liveDetail({ kind: 'key', keyId: 'k' }, [], [])).toBeNull();
    expect(detailKey({ kind: 'host' })).toBe('host:new');
    expect(detailKey({ kind: 'host', hostId: 'h1' })).toBe('host:h1');
    expect(detailKey({ kind: 'newKey' })).toBe('newKey:generate');
  });
});

describe('menuHosts', () => {
  it('lists groups first, at most 12, and says when there are more (R14)', () => {
    const hosts = [host('a', 'zeta'), host('b', 'alpha', 'prod'), ...Array.from({ length: 12 }, (_, i) => host(`x${i}`, `h${String(i).padStart(2, '0')}`, 'lab'))];
    const { shown, more } = menuHosts(hosts);
    expect(shown).toHaveLength(12);
    expect(shown[0].group).toBe('lab');
    expect(more).toBe(true);
    expect(menuHosts([host('a', 'one')])).toEqual({ shown: [host('a', 'one')], more: false });
  });
});

describe('newKeyDetail (W3)', () => {
  it('opens the asked mode; an open new-key pane always becomes a fresh pane in that mode', () => {
    const first = newKeyDetail(null, 'file');
    expect(first).toEqual({ kind: 'newKey', mode: 'file' });
    expect(detailKey(first)).toBe('newKey:file');
    expect(newKeyDetail({ kind: 'host', hostId: 'h1' }, 'paste')).toEqual({ kind: 'newKey', mode: 'paste' });
    const again = newKeyDetail(first, 'file');
    expect(again.mode).toBe('file');
    expect(detailKey(again)).not.toBe(detailKey(first));
    const other = newKeyDetail(again, 'generate');
    expect(other.mode).toBe('generate');
    expect(new Set([detailKey(first), detailKey(again), detailKey(other)]).size).toBe(3);
  });
});
