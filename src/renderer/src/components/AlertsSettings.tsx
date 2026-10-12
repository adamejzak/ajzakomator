import { useState } from 'react';
import { ALERT_EVENTS, isTime, normalizeVolume, type AlertEventId, type AlertSettings, type SoundChoice } from '../../../shared/alerts';
import { SOUND_PRESETS, getPreset } from '../../../shared/soundPresets';
import { updateSettings } from '../../../shared/state';
import type { MessageKey } from '../../../shared/i18n';
import { testAlert } from '../alerts';
import { useI18n } from '../i18n';
import { toast, update, useStore } from '../store';

const EVENT_LABELS: Record<AlertEventId, MessageKey> = {
  done: 'Skończył pracę',
  attention: 'Potrzebuje Ciebie',
  error: 'Błąd',
};

/** Value of the sound select for a choice: off, system, file or preset:<id>. */
const selectValue = (sound: SoundChoice) => (sound.kind === 'preset' ? `preset:${sound.id}` : sound.kind);

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The "Notifications and sounds" settings: one row per agent event, volume, the active-window option and quiet hours. */
export function AlertsSettings() {
  const { tr } = useI18n();
  const alerts = useStore((st) => st.s.settings.alerts);
  const [testing, setTesting] = useState<AlertEventId | null>(null);
  const setAlerts = (change: (current: AlertSettings) => AlertSettings) =>
    update((st) => updateSettings(st, { alerts: change(st.settings.alerts) }));
  const setEvent = (event: AlertEventId, patch: Partial<AlertSettings['events'][AlertEventId]>) =>
    setAlerts((a) => ({ ...a, events: { ...a.events, [event]: { ...a.events[event], ...patch } } }));

  const pickFile = async (event: AlertEventId) => {
    const path = await window.mc.pickSoundFile();
    if (path) setEvent(event, { sound: { kind: 'file', path } });
  };
  const chooseSound = (event: AlertEventId, value: string) => {
    if (value === 'file') { void pickFile(event); return; } // the choice changes only once a file was picked
    if (value === 'off' || value === 'system') setEvent(event, { sound: { kind: value } });
    else if (value.startsWith('preset:')) {
      const preset = getPreset(value.slice('preset:'.length));
      if (preset) setEvent(event, { sound: { kind: 'preset', id: preset.id } });
    }
  };
  const test = async (event: AlertEventId) => {
    setTesting(event);
    try {
      if (!(await testAlert(event))) toast(tr('Nie udało się odtworzyć pliku, użyto dźwięku systemowego.'), 'error');
    } finally {
      setTesting(null);
    }
  };
  const volumePercent = Math.round(alerts.volume * 100);
  const quiet = alerts.quietHours;
  const setQuiet = (patch: Partial<typeof quiet>) => setAlerts((a) => ({ ...a, quietHours: { ...a.quietHours, ...patch } }));

  return <>
    <div className="alert-events" role="group" aria-label={tr('Powiadomienia i dźwięki')}>
      {ALERT_EVENTS.map((event) => {
        const config = alerts.events[event];
        const label = tr(EVENT_LABELS[event]);
        return <div key={event} className="alert-row" role="group" aria-label={label} data-event={event}>
          <div className="alert-name">{label}</div>
          <label className="check alert-notify">
            <input type="checkbox" checked={config.notify} aria-label={tr('Powiadomienie: {event}', { event: label })}
              onChange={(e) => setEvent(event, { notify: e.target.checked })} />
            {tr('Powiadomienie systemowe')}
          </label>
          <select className="select alert-sound" aria-label={tr('Dźwięk: {event}', { event: label })}
            value={selectValue(config.sound)} onChange={(e) => chooseSound(event, e.target.value)}>
            <option value="off">{tr('Wyłączony')}</option>
            {SOUND_PRESETS.map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>{tr(preset.label)}</option>)}
            <option value="system">{tr('Dźwięk systemowy')}</option>
            <option value="file">{tr('Własny plik...')}</option>
          </select>
          <button type="button" className="btn alert-test" disabled={testing === event} aria-label={tr('Przetestuj: {event}', { event: label })}
            onClick={() => void test(event)}>{tr('Test')}</button>
          {config.sound.kind === 'file' && <div className="alert-file">
            <span className="muted" title={config.sound.path}>{fileName(config.sound.path)}</span>
            <button type="button" className="btn small" onClick={() => void pickFile(event)}>{tr('Wybierz plik...')}</button>
          </div>}
        </div>;
      })}
    </div>
    <div className="field">
      <div className="row alert-volume">
        <label htmlFor="settings-alert-volume">{tr('Głośność')}</label>
        <input id="settings-alert-volume" type="range" min={0} max={100} value={volumePercent}
          onChange={(e) => setAlerts((a) => ({ ...a, volume: normalizeVolume(Number(e.target.value) / 100, a.volume) }))} />
        <span className="muted" aria-live="polite">{volumePercent}%</span>
      </div>
    </div>
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={alerts.notifyWhenFocused} onChange={(e) => setAlerts((a) => ({ ...a, notifyWhenFocused: e.target.checked }))} />
        {tr('Powiadamiaj i graj dźwięk także w aktywnym oknie')}
      </label>
      <span className="muted">{tr('Domyślnie, gdy patrzysz na komórkę w aktywnym oknie aplikacji, nie dostajesz ani powiadomienia, ani dźwięku. Po włączeniu dostaniesz je zawsze, gdy agent skończy pracę, potrzebuje Ciebie albo zgłosi błąd.')}</span>
    </div>
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={quiet.enabled} onChange={(e) => setQuiet({ enabled: e.target.checked })} />
        {tr('Godziny ciszy')}
      </label>
      <div className="row alert-quiet">
        <label htmlFor="settings-quiet-start">{tr('Od')}</label>
        <input id="settings-quiet-start" className="input" type="time" value={quiet.start} disabled={!quiet.enabled}
          onChange={(e) => { if (isTime(e.target.value)) setQuiet({ start: e.target.value }); }} />
        <label htmlFor="settings-quiet-end">{tr('Do')}</label>
        <input id="settings-quiet-end" className="input" type="time" value={quiet.end} disabled={!quiet.enabled}
          onChange={(e) => { if (isTime(e.target.value)) setQuiet({ end: e.target.value }); }} />
      </div>
      <span className="muted">{tr('Nie powiadamiaj i nie graj dźwięku w godzinach ciszy')}. {tr('Ciche godziny mogą przechodzić przez północ, np. od 22:00 do 07:00.')}</span>
    </div>
    <div className="muted">{tr('Dotyczy agentów Claude i Codex: gdy skończą pracę, potrzebują Twojej odpowiedzi albo tura kończy się błędem. Przycisk testu odtwarza dokładnie wybrany dźwięk i wysyła przykładowe powiadomienie, jeśli jest włączone. Dźwięk systemowy ignoruje głośność.')}</div>
  </>;
}
