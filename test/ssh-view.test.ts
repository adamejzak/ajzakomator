import { describe, expect, it } from 'vitest';
import type { SshHost, SshSessionState } from '../src/shared/ssh';
import {
  chooseSshSection, DEFAULT_SSH_SECTION, detailKey, groupTiles, hostsInGroup, hostTileState, liveDetail, liveGroupFilter, menuHosts, newKeyDetail, paneDetail,
  resolveSshSection, sectionForDetail, showGroupRow, SSH_NAV, sshModeActive, toggleGroupFilter,
} from '../src/shared/sshView';

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

describe('SSH mode sections (0.9.2)', () => {
  it('lists Hosty, Klucze, Znane hosty and a disabled SFTP entry, in that order', () => {
    expect(SSH_NAV.map((e) => e.id)).toEqual(['hosts', 'keys', 'knownHosts', 'sftp']);
    expect(SSH_NAV.filter((e) => e.disabled).map((e) => e.id)).toEqual(['sftp']);
    expect(DEFAULT_SSH_SECTION).toBe('hosts');
  });

  it('never selects the disabled SFTP entry or an unknown one', () => {
    expect(chooseSshSection('keys', 'sftp')).toBe('keys');
    expect(chooseSshSection('hosts', 'nope')).toBe('hosts');
    expect(chooseSshSection('hosts', 'knownHosts')).toBe('knownHosts');
    expect(chooseSshSection('knownHosts', 'keys')).toBe('keys');
    for (const junk of [undefined, null, 5, '', 'sftp', 'Hosts', '__proto__']) expect(resolveSshSection(junk)).toBe('hosts');
    expect(resolveSshSection('keys')).toBe('keys');
  });

  it('puts a detail into its section and shows only the own detail of a section', () => {
    expect(sectionForDetail(null)).toBeNull();
    expect(sectionForDetail({ kind: 'host' })).toBe('hosts');
    expect(sectionForDetail({ kind: 'key', keyId: 'k' })).toBe('keys');
    expect(sectionForDetail({ kind: 'newKey', mode: 'paste' })).toBe('keys');
    expect(paneDetail('hosts', { kind: 'host', hostId: 'h1' })).toEqual({ kind: 'host', hostId: 'h1' });
    expect(paneDetail('hosts', { kind: 'newKey' })).toBeNull();
    expect(paneDetail('keys', { kind: 'host', hostId: 'h1' })).toBeNull();
    expect(paneDetail('knownHosts', { kind: 'key', keyId: 'k' })).toBeNull();
  });

  it('is SSH mode only while the view is in front and Settings is not', () => {
    expect(sshModeActive({ viewActive: true, settingsActive: false })).toBe(true);
    expect(sshModeActive({ viewActive: true, settingsActive: true })).toBe(false);
    expect(sshModeActive({ viewActive: false, settingsActive: false })).toBe(false);
  });
});

describe('group tiles (0.9.2)', () => {
  const hosts = [host('a', 'web-2', 'lab'), host('b', 'web-1', 'lab'), host('c', 'pi'), host('d', 'db', 'prod')];
  it('counts the hosts per group, named groups first, then the hosts without a group', () => {
    expect(groupTiles(hosts)).toEqual([{ key: 'lab', name: 'lab', count: 2 }, { key: 'prod', name: 'prod', count: 1 }, { key: '', name: null, count: 1 }]);
    expect(showGroupRow(groupTiles(hosts))).toBe(true);
    expect(showGroupRow(groupTiles([host('c', 'pi')]))).toBe(false);
    expect(groupTiles([])).toEqual([]);
  });

  it('filters by a group tile, toggles it off and forgets a group that has no hosts any more', () => {
    expect(hostsInGroup(hosts, null).map((h) => h.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(hostsInGroup(hosts, 'lab').map((h) => h.id)).toEqual(['a', 'b']);
    expect(hostsInGroup(hosts, '').map((h) => h.id)).toEqual(['c']);
    expect(toggleGroupFilter(null, 'lab')).toBe('lab');
    expect(toggleGroupFilter('lab', 'lab')).toBeNull();
    expect(toggleGroupFilter('lab', 'prod')).toBe('prod');
    expect(liveGroupFilter('lab', hosts)).toBe('lab');
    expect(liveGroupFilter('gone', hosts)).toBeNull();
    expect(liveGroupFilter('', [host('a', 'x', 'lab')])).toBeNull();
    expect(liveGroupFilter(null, hosts)).toBeNull();
  });
});
