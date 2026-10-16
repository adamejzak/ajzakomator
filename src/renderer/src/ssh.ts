// SSH actions of the renderer: connect, reconnect and disconnect cells, open hosts in cells and tabs, follow session events.
// Imports actions.ts for cell helpers, and actions.ts imports this module: a static cycle, safe because neither module uses
// the other at load time (only inside functions).
import { layoutForCount as layoutFor } from '../../shared/layout';
import { activeProject, activeTab, addCell, ensureShellProfile, findCell, removeSshHost } from '../../shared/state';
import { closeEditorTab, hostEndpoint, openEditorTab, promptNeedsToast, restoredPromptToasts, sshCellStart, sshCellVisible, sshGridName, sshNotice, sshSessionEnded, type SshEditorRef, type SshPrompt, type SshSessionState, type SshVaultInfo } from '../../shared/ssh';
import type { MessageKey, MessageParams } from '../../shared/i18n';
import type { AppState } from '../../shared/types';
import { createProject, ensureTerminal, focusCell, openTab } from './actions';
import { useFileStore } from './files';
import { tr } from './i18n';
import { askChoice, getS, getUi, setUi, toast, update } from './store';
import { createInitGate, useSshStore } from './sshStore';
import { terminals } from './terminals/TerminalManager';

/** SSH cells created by the user in this renderer session: they connect when their view mounts (spec 6.1 step 1). */
export const connectOnMount = new Set<string>();

export function sshContext(hostId?: string): { host: string; endpoint: string } {
  const host = hostId ? getS().sshHosts.find((h) => h.id === hostId) : undefined;
  return host ? { host: host.address, endpoint: hostEndpoint(host.address, host.port) } : { host: '', endpoint: '' };
}

const cellLabel = (cellId: string): string => {
  const found = findCell(getS(), cellId);
  const host = found?.cell.ssh ? getS().sshHosts.find((h) => h.id === found.cell.ssh!.hostId) : undefined;
  return found?.cell.name ?? host?.label ?? tr('Host usunięty');
};

const cellVisible = (cellId: string): boolean => {
  const tab = activeTab(activeProject(getS()));
  const max = getUi().maximizedCellId;
  return sshCellVisible({
    cellId,
    inActiveTab: !!tab?.cells.some((c) => c.id === cellId),
    covered: getUi().settingsActive || !!useSshStore.getState().activeEditorId || !!useFileStore.getState().activeFileId,
    maximizedCellId: max && tab?.cells.some((c) => c.id === max) ? max : null,
  });
};

const announcePrompt = (cellId: string): void => toast(tr('SSH: {name} czeka na Twoją decyzję', { name: cellLabel(cellId) }));

function onSession(state: SshSessionState): void {
  const previous = useSshStore.getState().sessions[state.cellId]?.phase;
  useSshStore.getState().setSession(state);
  // I2: a network drop or a close while vim or htop ran leaves the alternate screen, so the notice below stays readable.
  if (sshSessionEnded(previous, state.phase)) terminals.resetSshModes(state.cellId);
  const notice = sshNotice(previous, state, sshContext(state.hostId));
  if (!notice) return;
  const text = notice.key === '[SSH · błąd: {reason}]'
    ? tr(notice.key, { reason: tr(notice.reason.key, notice.reason.params) })
    : tr(notice.key, 'params' in notice ? notice.params : undefined);
  terminals.writeNotice(state.cellId, text);
}

function onPrompt(cellId: string, prompt: SshPrompt | null): void {
  const previousId = useSshStore.getState().prompts[cellId]?.id;
  useSshStore.getState().setPrompt(cellId, prompt);
  if (prompt && promptNeedsToast({ visible: cellVisible(cellId), previousId, nextId: prompt.id })) announcePrompt(cellId);
}

export async function initSsh(): Promise<void> {
  const gate = createInitGate();
  window.mc.on('ssh:session', gate.wrap(onSession));
  window.mc.on('ssh:prompt', gate.wrap(onPrompt));
  window.mc.on('ssh:vault:changed', gate.wrap((vault) => useSshStore.getState().setVault(vault)));
  try {
    const [vault, snapshot] = await Promise.all([window.mc.ssh.vaultInfo(), window.mc.ssh.sessions()]);
    useSshStore.getState().load(vault, snapshot);
    // A reload keeps the prompts open in main (R7): a hidden cell that waits is announced again (Review Focus 2 and 3).
    // Before the held events run (M7): a prompt that arrived meanwhile announces itself through onPrompt.
    for (const cellId of restoredPromptToasts(useSshStore.getState().prompts, cellVisible)) announcePrompt(cellId);
  } finally { gate.open(); }
}

/** Called by startOnce for SSH cells (D5: never a connect without the user's intent). */
export function startSshCell(cellId: string, alive: boolean): void {
  const found = findCell(getS(), cellId);
  if (!found?.cell.ssh) return;
  const decision = sshCellStart({ alive, connectOnMount: connectOnMount.delete(cellId) });
  if (decision === 'connect') { void connectCell(cellId); return; }
  if (decision === 'idle' && !useSshStore.getState().sessions[cellId]) {
    useSshStore.getState().setSession({ cellId, hostId: found.cell.ssh.hostId, phase: 'idle', since: Date.now() });
  }
}

export async function connectCell(cellId: string): Promise<void> {
  const found = findCell(getS(), cellId);
  const ref = found?.cell.ssh;
  if (!ref) return;
  ensureTerminal(cellId);
  terminals.prepareReconnect(cellId);
  const { cols, rows } = terminals.size(cellId);
  const result = await window.mc.ssh.connect({ cellId, hostId: ref.hostId, cols, rows });
  // A refusal before any session event: the same path as an event, so the "[SSH · błąd: ...]" line is written too.
  if (!result.ok) onSession({ cellId, hostId: ref.hostId, phase: 'error', error: result.error, since: Date.now() });
  else terminals.syncSize(cellId);
}

export async function reconnectCell(cellId: string): Promise<void> {
  await window.mc.killCellAndWait(cellId);
  await connectCell(cellId);
}

export function disconnectCell(cellId: string): void {
  window.mc.killCell(cellId);
}

/** Opens one host in the active grid (a new cell) or in a new tab. No project yet: the usual "create project" flow (D4). */
export async function openHostInCell(hostId: string, target: 'cell' | 'tab'): Promise<void> {
  const host = getS().sshHosts.find((h) => h.id === hostId);
  const project = activeProject(getS());
  if (!host) return;
  if (!project) return createProject();
  const tab = activeTab(project);
  if (target === 'tab' || !tab) return openSshTab(project.id, [hostId], host.label);
  if (tab.cells.length >= 20) return void toast(tr('Siatka ma już maksymalnie 20 komórek'), 'error');
  update((s) => { const r = ensureShellProfile(s); return addCell(r.s, project.id, tab.id, r.profileId, { ssh: { hostId } }); });
  const cell = activeTab(activeProject(getS()))?.cells.at(-1);
  // The cell view mounts in a later effect, so marking it here is in time.
  if (cell?.ssh) { connectOnMount.add(cell.id); focusCell(cell.id); }
}

/** A new tab with one SSH cell per host; openTab marks the cells for connectOnMount before they render. */
export async function openSshTab(projectId: string, hostIds: string[], name?: string): Promise<void> {
  let profileId = '';
  update((s) => { const r = ensureShellProfile(s); profileId = r.profileId; return r.s; });
  await openTab(projectId, layoutFor(hostIds.length), hostIds.map((sshHostId) => ({ profileId, worktree: false, sshHostId })), name);
}

/** A new tab with one connecting cell per host (at most 20), named after the shared group or by count. */
export async function openHostsAsGrid(hostIds: string[]): Promise<void> {
  const project = activeProject(getS());
  if (!project) return createProject();
  const hosts = hostIds.map((id) => getS().sshHosts.find((h) => h.id === id)).filter((h): h is NonNullable<typeof h> => !!h).slice(0, 20);
  if (!hosts.length) return;
  const name = sshGridName(hosts);
  await openSshTab(project.id, hosts.map((h) => h.id), 'group' in name ? name.group : tr('SSH ({count})', { count: name.count }));
}

/** Asks before deleting a host (shared by the host list and the host editor); true when it was deleted. */
export async function confirmRemoveSshHost(hostId: string): Promise<boolean> {
  const host = getS().sshHosts.find((h) => h.id === hostId);
  if (!host) return false;
  const choice = await askChoice(tr('Usunąć host {name}?', { name: host.label }), '', [{ label: tr('Usuń host'), value: 'yes', danger: true }]);
  if (choice !== 'yes') return false;
  update((s) => removeSshHost(s, hostId));
  return true;
}

// ── editor tabs (spec 10.2) ──────────────────────────────────────────────────

/** The title of an editor tab, as plain text (used by the tab strip and the all-tabs menu). */
export function sshEditorTitleText(editor: SshEditorRef, state: AppState, vault: SshVaultInfo | null, t: (key: MessageKey, params?: MessageParams) => string): string {
  if (editor.kind === 'newKey') return t('Nowy klucz');
  if (editor.kind === 'host') return state.sshHosts.find((h) => h.id === editor.targetId)?.label ?? t('Nowy host');
  return vault?.keys.find((k) => k.id === editor.targetId)?.label ?? t('Klucz');
}

export function openSshEditor(kind: SshEditorRef['kind'], targetId?: string): void {
  const { editors } = useSshStore.getState();
  const r = openEditorTab(editors, kind, targetId, crypto.randomUUID());
  useSshStore.setState({ editors: r.list, activeEditorId: r.id });
  setUi({ settingsActive: false });
}

export function activateSshEditor(id: string): void {
  if (!useSshStore.getState().editors.some((e) => e.id === id)) return;
  useSshStore.setState({ activeEditorId: id });
  setUi({ settingsActive: false });
}

export function closeSshEditor(id: string): void {
  const { editors, activeEditorId } = useSshStore.getState();
  const r = closeEditorTab(editors, activeEditorId, id);
  useSshStore.setState({ editors: r.list, activeEditorId: r.activeId });
}

/** "Nowy host" saved, or a new key stored: the same tab now edits that host or key. */
export function retargetSshEditor(id: string, kind: 'host' | 'key', targetId: string): void {
  useSshStore.setState((st) => ({ editors: st.editors.map((e) => (e.id === id ? { id, kind, targetId } : e)) }));
}
