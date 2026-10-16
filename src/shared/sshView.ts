// Pure helpers of the SSH view (the `ssh` workspace tab, W3). No DOM imports: tested in Node.
import { groupHosts, isLivePhase, type SshHost, type SshSessionState } from './ssh';

/** What the details pane of the SSH view shows; a host without id is the "Nowy host" form. */
export type SshDetail =
  | { kind: 'host'; hostId?: string }
  | { kind: 'key'; keyId: string }
  | { kind: 'newKey'; mode?: 'generate' | 'file' | 'paste' };

export type HostTileState = 'connected' | 'connecting' | 'error' | 'idle';

/** The dot of a host tile: the best state among the cells (in any project and grid) that run this host. */
export function hostTileState(hostId: string, cells: ReadonlyArray<{ id: string; ssh?: { hostId: string } }>, sessions: Readonly<Record<string, SshSessionState | undefined>>): HostTileState {
  let state: HostTileState = 'idle';
  for (const cell of cells) {
    if (cell.ssh?.hostId !== hostId) continue;
    const phase = sessions[cell.id]?.phase;
    if (phase === 'connected') return 'connected';
    if (isLivePhase(phase)) state = 'connecting';
    else if (phase === 'error' && state === 'idle') state = 'error';
  }
  return state;
}

/** A detail whose host or key no longer exists shows the empty hint instead. */
export function liveDetail(detail: SshDetail | null, hosts: ReadonlyArray<Pick<SshHost, 'id'>>, keyIds: readonly string[]): SshDetail | null {
  if (!detail) return null;
  if (detail.kind === 'host' && detail.hostId && !hosts.some((h) => h.id === detail.hostId)) return null;
  if (detail.kind === 'key' && !keyIds.includes(detail.keyId)) return null;
  return detail;
}

/** React key of the pane: another host or key is a fresh pane (typed secrets and drafts of the previous one are dropped, R12). */
export const detailKey = (d: SshDetail): string => (d.kind === 'host' ? `host:${d.hostId ?? 'new'}` : d.kind === 'key' ? `key:${d.keyId}` : `newKey:${d.mode ?? 'generate'}`);

export const MENU_HOSTS = 12;

/** Hosts offered in the "Dodaj" and cell menus (R14): the view's order (groups, then hosts by label), at most `max`. */
export function menuHosts(hosts: readonly SshHost[], max = MENU_HOSTS): { shown: SshHost[]; more: boolean } {
  const ordered = groupHosts(hosts).flatMap((g) => g.hosts);
  return { shown: ordered.slice(0, max), more: ordered.length > max };
}
