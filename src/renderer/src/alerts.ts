// Raises the alerts (OS notification and sound) for agent status changes. The decision itself is pure (shared/alerts).
import { ALERT_EVENTS, createAlertSoundThrottle, decideAlert, errorPhrase, type AlertEventId } from '../../shared/alerts';
import { activeProject, activeTab, findCell, getProfile } from '../../shared/state';
import type { CellStatus, HookInfo, StatusCause, StatusReason } from '../../shared/status';
import { playAlertSound } from './alertSound';
import { tr } from './i18n';
import { getS, getUi } from './store';
import { statusLog } from './terminals/TerminalManager';

function isVisible(cellId: string): boolean {
  const tab = activeTab(activeProject(getS()));
  if (!tab?.cells.some((c) => c.id === cellId)) return false;
  const max = getUi().maximizedCellId;
  return !max || max === cellId;
}

/** Body of the OS notification: what happened to which agent (and for an error, the human phrase of its code). */
export function alertBody(event: AlertEventId, name: string, errorCode?: string): string {
  if (event === 'attention') return tr('{name} potrzebuje Ciebie', { name });
  if (event === 'error') return tr('{name} - błąd: {detail}', { name, detail: tr(errorPhrase(errorCode)) });
  return tr('{name} skończył pracę', { name });
}

const allowSound = createAlertSoundThrottle();

/** Called for every status change of a cell; raises whatever the alert settings and the status rules allow. */
export function alertForStatus(
  cellId: string, status: CellStatus, prev: CellStatus, cause: StatusCause, reason: StatusReason, hooked: boolean, info?: HookInfo,
): void {
  if (status !== 'waiting') return;
  const s = getS();
  const found = findCell(s, cellId);
  if (!found) return;
  const profile = getProfile(s, found.cell.profileId);
  const decision = decideAlert(s.settings.alerts, {
    prev, status, cause, hooked, reason, agent: profile.cli !== 'shell', now: new Date(), allowSound,
    userLooking: document.hasFocus() && isVisible(cellId),
  });
  if (decision.suppressed) statusLog.markAlert(cellId, decision.suppressed);
  if (!decision.notify && !decision.sound) return;
  statusLog.markAlert(cellId);
  if (decision.notify) {
    const n = found.tab.cells.findIndex((c) => c.id === cellId) + 1;
    window.mc.notify({
      title: `${found.project.name} · ${found.tab.name} #${n}`,
      body: alertBody(decision.event, profile.name, info?.error),
      cellId,
    });
  }
  if (decision.sound) void playAlertSound(decision.event, decision.sound);
}

let previewing = false;

/** Short preview of an event sound at `volume` after the slider was committed; never overlaps itself. System beeps are skipped (they ignore the volume). */
export async function previewVolume(volume: number): Promise<void> {
  if (previewing) return;
  const { events } = getS().settings.alerts;
  const event = ALERT_EVENTS.find((e) => events[e].sound.kind === 'preset' || events[e].sound.kind === 'file');
  if (!event) return;
  previewing = true;
  try {
    await playAlertSound(event, events[event].sound, volume);
  } finally {
    setTimeout(() => { previewing = false; }, 700);
  }
}

/** The test button of the settings: plays exactly what would play, and sends a sample notification only when it is on. */
export async function testAlert(event: AlertEventId): Promise<boolean> {
  const s = getS();
  const { alerts } = s.settings;
  const config = alerts.events[event];
  const agent = s.profiles.find((p) => p.cli === 'claude')?.name ?? 'Claude';
  if (config.notify) window.mc.notify({ title: 'ajzakomator', body: alertBody(event, agent, 'rate_limit'), cellId: '' });
  return playAlertSound(event, config.sound, alerts.volume);
}
