import { Select } from './Select';
import { SettingRow } from './SettingRow';
import { useEffect, useRef, useState } from 'react';
import { ALERT_EVENTS, isTime, normalizeVolume, type AlertEventId, type AlertSettings, type SoundChoice } from '../../../shared/alerts';
import { SOUND_PRESETS, getPreset } from '../../../shared/soundPresets';
import { updateSettings } from '../../../shared/state';
import type { MessageKey } from '../../../shared/i18n';
import { previewVolume, testAlert } from '../alerts';
import { useI18n } from '../i18n';
import { getS, toast, update, useStore } from '../store';

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
  // The slider keeps a local draft while it is dragged; the state edit (and the preview) happen once it is released.
  const [draft, setDraft] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const dragging = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
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
      const kind = getS().settings.alerts.events[event].sound.kind;
      if (!(await testAlert(event))) {
        toast(kind === 'file' ? tr('Nie udało się odtworzyć pliku, użyto dźwięku systemowego.') : tr('Nie udało się odtworzyć dźwięku, użyto dźwięku systemowego.'), 'error');
      }
    } finally {
      setTesting(null);
    }
  };
  const savedPercent = Math.round(alerts.volume * 100);
  const volumePercent = draft ?? savedPercent;
  const commitVolume = (percent: number) => {
    window.clearTimeout(timer.current);
    dragging.current = false;
    setDraft(null);
    if (percent === savedPercent) return;
    const volume = normalizeVolume(percent / 100, alerts.volume);
    setAlerts((a) => ({ ...a, volume }));
    setAnnounce(tr('Głośność ustawiona na {value}%', { value: percent }));
    void previewVolume(volume);
  };
  const quiet = alerts.quietHours;
  const setQuiet = (patch: Partial<typeof quiet>) => setAlerts((a) => ({ ...a, quietHours: { ...a.quietHours, ...patch } }));

  return <>
    <div className="alert-events" role="group" aria-label={tr('Powiadomienia i dźwięki')}>
      {ALERT_EVENTS.map((event) => {
        const config = alerts.events[event];
        const label = tr(EVENT_LABELS[event]);
        return <div key={event} className="alert-event-settings" role="group" aria-label={label} data-event={event}>
          <SettingRow title={tr('Powiadomienie systemowe: {event}', { event: label })} htmlFor={`settings-alert-notify-${event}`}>
            <input id={`settings-alert-notify-${event}`} className="setting-switch" type="checkbox" role="switch" checked={config.notify}
              onChange={(e) => setEvent(event, { notify: e.target.checked })} />
          </SettingRow>
          <SettingRow title={tr('Dźwięk: {event}', { event: label })} htmlFor={`settings-alert-sound-${event}`}>
          <Select id={`settings-alert-sound-${event}`} className="select alert-sound" aria-label={tr('Dźwięk: {event}', { event: label })}
            value={selectValue(config.sound)} onChange={(e) => chooseSound(event, e.target.value)}>
            <option value="off">{tr('Wyłączony')}</option>
            {SOUND_PRESETS.map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>{tr(preset.label)}</option>)}
            <option value="system">{tr('Dźwięk systemowy')}</option>
            <option value="file">{tr('Własny plik...')}</option>
          </Select>
          <button type="button" className="btn alert-test" disabled={testing === event} aria-label={tr('Test: {event}', { event: label })}
            onClick={() => void test(event)}>{tr('Test')}</button>
          </SettingRow>
          {config.sound.kind === 'file' && <div className="alert-file">
            <span className="muted" title={config.sound.path}>{fileName(config.sound.path)}</span>
            <button type="button" className="btn small" aria-label={tr('Wybierz plik dla zdarzenia: {event}', { event: label })} onClick={() => void pickFile(event)}>{tr('Wybierz plik...')}</button>
          </div>}
        </div>;
      })}
    </div>
    <SettingRow title={tr('Głośność')} htmlFor="settings-alert-volume">
        <input id="settings-alert-volume" type="range" min={0} max={100} value={volumePercent} aria-valuetext={`${volumePercent}%`}
          onPointerDown={() => { dragging.current = true; }}
          onPointerUp={(e) => commitVolume(Number(e.currentTarget.value))}
          onPointerCancel={(e) => commitVolume(Number(e.currentTarget.value))}
          onKeyUp={(e) => commitVolume(Number(e.currentTarget.value))}
          onBlur={(e) => commitVolume(Number(e.currentTarget.value))}
          onChange={(e) => {
            const percent = Number(e.target.value);
            setDraft(percent);
            window.clearTimeout(timer.current);
            // Changes that come with no pointer or key release (assistive technology) are committed after a short pause.
            if (!dragging.current) timer.current = window.setTimeout(() => commitVolume(percent), 300);
          }} />
        <span className="muted" aria-hidden="true">{volumePercent}%</span>
        <span className="sr-only" role="status">{announce}</span>
    </SettingRow>
    <SettingRow title={tr('Powiadamiaj i graj dźwięk także w aktywnym oknie')} htmlFor="settings-alert-focused" hint={tr('Domyślnie, gdy patrzysz na komórkę w aktywnym oknie aplikacji, nie dostajesz ani powiadomienia, ani dźwięku. Po włączeniu dostaniesz je zawsze, gdy agent skończy pracę, potrzebuje Ciebie albo zgłosi błąd.')}>
        <input id="settings-alert-focused" className="setting-switch" type="checkbox" role="switch" checked={alerts.notifyWhenFocused} onChange={(e) => setAlerts((a) => ({ ...a, notifyWhenFocused: e.target.checked }))} />
    </SettingRow>
    <SettingRow title={tr('Godziny ciszy')} htmlFor="settings-quiet-enabled" hint={tr('Nie powiadamiaj i nie graj dźwięku w godzinach ciszy')}>
        <input id="settings-quiet-enabled" className="setting-switch" type="checkbox" role="switch" checked={quiet.enabled} onChange={(e) => setQuiet({ enabled: e.target.checked })} />
    </SettingRow>
    <SettingRow title={`${tr('Od')} / ${tr('Do')}`} hint={tr('Ciche godziny mogą przechodzić przez północ, np. od 22:00 do 07:00.')}>
      <div className="row alert-quiet">
        <label htmlFor="settings-quiet-start">{tr('Od')}</label>
        <input id="settings-quiet-start" className="input" type="time" value={quiet.start} disabled={!quiet.enabled}
          onChange={(e) => { if (isTime(e.target.value)) setQuiet({ start: e.target.value }); }} />
        <label htmlFor="settings-quiet-end">{tr('Do')}</label>
        <input id="settings-quiet-end" className="input" type="time" value={quiet.end} disabled={!quiet.enabled}
          onChange={(e) => { if (isTime(e.target.value)) setQuiet({ end: e.target.value }); }} />
      </div>
    </SettingRow>
    <div className="muted">{tr('Dotyczy agentów Claude i Codex: gdy skończą pracę, potrzebują Twojej odpowiedzi albo tura kończy się błędem. Przycisk testu odtwarza dokładnie wybrany dźwięk i wysyła przykładowe powiadomienie, jeśli jest włączone. Dźwięk systemowy ignoruje głośność.')}</div>
  </>;
}
