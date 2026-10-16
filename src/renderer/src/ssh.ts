// SSH actions of the renderer: connect, reconnect and disconnect cells, open hosts in cells and tabs, follow session events.
// Imports actions.ts for cell helpers, and actions.ts imports this module: a static cycle, safe because neither module uses
// the other at load time (only inside functions).
import { layoutForCount as layoutFor } from '../../shared/layout';
import { activeProject, activeTab, addCell, ensureShellProfile, findCell } from '../../shared/state';
import { hostEndpoint, promptNeedsToast, restoredPromptToasts, sshCellStart, sshCellVisible, sshNotice, type SshPrompt, type SshSessionState } from '../../shared/ssh';
import { createProject, ensureTerminal, focusCell, openTab } from './actions';
import { useFileStore } from './files';
import { tr } from './i18n';
import { getS, getUi, toast, update } from './store';
import { useSshStore } from './sshStore';
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
  window.mc.on('ssh:session', onSession);
  window.mc.on('ssh:prompt', onPrompt);
  window.mc.on('ssh:vault:changed', (vault) => useSshStore.getState().setVault(vault));
  const [vault, snapshot] = await Promise.all([window.mc.ssh.vaultInfo(), window.mc.ssh.sessions()]);
  useSshStore.getState().load(vault, snapshot);
  // A reload keeps the prompts open in main (R7): a hidden cell that waits is announced again (Review Focus 2 and 3).
  for (const cellId of restoredPromptToasts(useSshStore.getState().prompts, cellVisible)) announcePrompt(cellId);
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
