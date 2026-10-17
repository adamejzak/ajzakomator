// Pure helpers of the SSH view (the `ssh` workspace tab, W3). No DOM imports: tested in Node.
import { groupHosts, isLivePhase, type SshHost, type SshSessionState } from './ssh';

/** What the details pane of the SSH view shows; a host without id is the "Nowy host" form. */
export type SshDetail =
  | { kind: 'host'; hostId?: string }
  | { kind: 'key'; keyId: string }
  | { kind: 'newKey'; mode?: NewKeyMode; seq?: number };

export type NewKeyMode = 'generate' | 'file' | 'paste';

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
export const detailKey = (d: SshDetail): string => (d.kind === 'host' ? `host:${d.hostId ?? 'new'}` : d.kind === 'key' ? `key:${d.keyId}` : `newKey:${d.mode ?? 'generate'}${d.seq ? `:${d.seq}` : ''}`);

/** "Nowy klucz > mode" from the header: an open new-key pane (in any mode) is replaced by a fresh one in the asked mode. */
export function newKeyDetail(current: SshDetail | null, mode: NewKeyMode): SshDetail & { kind: 'newKey' } {
  return current?.kind === 'newKey' ? { kind: 'newKey', mode, seq: (current.seq ?? 0) + 1 } : { kind: 'newKey', mode };
}

export const MENU_HOSTS = 12;

/** Hosts offered in the "Dodaj" and cell menus (R14): the view's order (groups, then hosts by label), at most `max`. */
export function menuHosts(hosts: readonly SshHost[], max = MENU_HOSTS): { shown: SshHost[]; more: boolean } {
  const ordered = groupHosts(hosts).flatMap((g) => g.hosts);
  return { shown: ordered.slice(0, max), more: ordered.length > max };
}

// ── SSH mode (0.9.2): the left side panel shows the SSH sections while the SSH view is in front ──

/** The sections of the SSH view; SFTP is listed in the navigation but is not a section yet. */
export type SshSection = 'hosts' | 'keys' | 'knownHosts';

export interface SshNavEntry { id: SshSection | 'sftp'; label: 'Hosty' | 'Klucze' | 'Znane hosty' | 'SFTP'; disabled?: true }

/** The navigation of SSH mode, in order. A disabled entry is shown greyed with "wkrótce" and can never be chosen. */
export const SSH_NAV: readonly SshNavEntry[] = [
  { id: 'hosts', label: 'Hosty' },
  { id: 'keys', label: 'Klucze' },
  { id: 'knownHosts', label: 'Znane hosty' },
  { id: 'sftp', label: 'SFTP', disabled: true },
];

export const DEFAULT_SSH_SECTION: SshSection = 'hosts';

/** A click on a navigation entry: an enabled one becomes the section, a disabled or unknown one changes nothing. */
export function chooseSshSection(current: SshSection, clicked: string): SshSection {
  const entry = SSH_NAV.find((e) => e.id === clicked);
  return entry && !entry.disabled ? (entry.id as SshSection) : current;
}

/** The section a detail belongs to (a host form to Hosty, a key or a new-key form to Klucze); null keeps the current one. */
export function sectionForDetail(detail: SshDetail | null): SshSection | null {
  if (!detail) return null;
  return detail.kind === 'host' ? 'hosts' : 'keys';
}

/** What the details pane of a section shows: only a detail of that section (Znane hosty has no pane). */
export function paneDetail(section: SshSection, detail: SshDetail | null): SshDetail | null {
  return detail && sectionForDetail(detail) === section ? detail : null;
}

/**
 * The store change for a click in the SSH mode navigation: the new section, the detail only if it belongs there (a new-key
 * draft or a host form of the old section is dropped) and the host selection only in Hosty. Nothing for SFTP or the same section.
 */
export function sectionChange(st: { section: SshSection; detail: SshDetail | null; selectedHosts: string[] }, clicked: string): Partial<{ section: SshSection; detail: SshDetail | null; selectedHosts: string[] }> {
  const section = chooseSshSection(st.section, clicked);
  if (section === st.section) return {};
  return { section, detail: paneDetail(section, st.detail), selectedHosts: section === 'hosts' ? st.selectedHosts : [] };
}

/** SSH mode: the SSH view is the workspace on screen (Settings in front ends it). */
export const sshModeActive = (ctx: { viewActive: boolean; settingsActive: boolean }): boolean => ctx.viewActive && !ctx.settingsActive;

export interface GroupTile { key: string; name: string | null; count: number }

/** The "Grupy" row: one tile per group in the view's order (named groups by name, then the hosts without a group). */
export function groupTiles(hosts: readonly SshHost[]): GroupTile[] {
  return groupHosts(hosts).map((g) => ({ key: g.name ?? '', name: g.name, count: g.hosts.length }));
}

/** The row is only worth showing when at least one host has a group. */
export const showGroupRow = (tiles: readonly GroupTile[]): boolean => tiles.some((t) => t.name !== null);

/** Hosts of the chosen group tile ('' = without a group); null shows every host. */
export function hostsInGroup(hosts: readonly SshHost[], groupKey: string | null): SshHost[] {
  return groupKey === null ? [...hosts] : hosts.filter((h) => (h.group ?? '') === groupKey);
}

/** A group filter whose group no longer has hosts (renamed, emptied) falls back to every host. */
export function liveGroupFilter(groupKey: string | null, hosts: readonly SshHost[]): string | null {
  return groupKey !== null && hosts.some((h) => (h.group ?? '') === groupKey) ? groupKey : null;
}

/** A click on a group tile filters to that group; a click on the chosen one shows every host again. */
export const toggleGroupFilter = (current: string | null, clicked: string): string | null => (current === clicked ? null : clicked);
