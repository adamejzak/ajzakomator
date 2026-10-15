import { Select } from './Select';
import { SettingRow, SettingsGroup } from './SettingRow';
import { ColorPicker } from './ColorPicker';
import { ProfileOptions } from './ProfileOptions';
import { useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { update, useStore, toast } from '../store';
import { updateSettings, upsertProfile, removeProfile, uid } from '../../../shared/state';
import type { CliKind, ShellKind } from '../../../shared/types';
import { normalizeUpdateMode } from '../../../shared/updateMode';
import { AlertsSettings } from './AlertsSettings';
import { ShortcutsSettings } from './ShortcutsSettings';
import { isLanguage, LANGUAGES } from '../../../shared/languages';
import { shellsForPlatform } from '../../../shared/platform';
import { USAGE_INTERVALS_MINUTES } from '../../../shared/usage';
import { BACKGROUND_LOAD_MODES, BACKGROUND_MAX_CELLS, normalizeBackgroundLoad, type BackgroundLoadMode } from '../../../shared/backgroundLoad';
import type { MessageKey } from '../../../shared/i18n';
import { IX, TSettings } from './icons';

const BACKGROUND_LABEL: Record<BackgroundLoadMode, MessageKey> = { visible: 'Tylko widoczne (jak dotąd)', project: 'Zakładki aktywnego projektu', all: 'Wszystkie projekty' };
const BACKGROUND_HINT: Record<BackgroundLoadMode, MessageKey> = {
  visible: 'Sesje startują dopiero po otwarciu zakładki. Zakładki bez uruchomionych sesji nie pokazują statusu ani alertów.',
  project: 'Pozostałe zakładki aktywnego projektu startują w tle (do {max} sesji po uruchomieniu). Inne projekty i reszta sesji startują po otwarciu.',
  all: 'Zakładki wszystkich projektów startują w tle, po kolei (do {max} sesji po uruchomieniu). Reszta startuje po otwarciu. Zużywa więcej pamięci i procesora.',
};
const sections = ["Ustawienia aplikacji", "Terminal", "Powiadomienia i dźwięki", "Aktualizacje", "Konta AI", "Profile agentów", "Skróty klawiszowe"] as const;
export function SettingsPage() {
  const { tr, language } = useI18n();
  const s = useStore((st) => st.s);
  const [section, setSection] = useState(0);
  const settingsId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectSection = (index: number) => {
    setSection(index);
    contentRef.current?.scrollTo({ top: 0 });
  };
  const setSetting = (patch: Partial<typeof s.settings>) => update((st) => updateSettings(st, patch));
  return <div className="settings-page">
    <nav className="settings-nav" aria-label={tr('Ustawienia')}>
      <div className="settings-nav-title"><TSettings />{tr('Ustawienia')}</div>
      <div role="tablist" aria-label={tr('Ustawienia')} aria-orientation="vertical">
        {sections.map((label, index) => <button key={label} type="button" role="tab"
          id={`${settingsId}-section-${index}`} aria-controls={`${settingsId}-content`} aria-selected={section === index}
          tabIndex={section === index ? 0 : -1} ref={(element) => { sectionRefs.current[index] = element; }}
          className={section === index ? 'on' : ''} onClick={() => selectSection(index)}
          onKeyDown={(event) => {
            const next = event.key === 'ArrowDown' ? (index + 1) % sections.length
              : event.key === 'ArrowUp' ? (index + sections.length - 1) % sections.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : undefined;
            if (next === undefined) return;
            event.preventDefault();
            selectSection(next);
            sectionRefs.current[next]?.focus();
          }}>{tr(label)}</button>)}
      </div>
    </nav>
    <div className="settings-content" ref={contentRef} role="tabpanel" id={`${settingsId}-content`}
      aria-labelledby={`${settingsId}-section-${section}`} tabIndex={0}>
      <h2>{tr(sections[section])}</h2>
      <div className="settings-groups">
      {section === 0 && <SettingsGroup>
        <SettingRow title={tr('Język aplikacji')} htmlFor="settings-language" hint={tr('Zmiana języka działa od razu.')}>
          <Select id="settings-language" className="select" value={language} onChange={(event) => {
            if (isLanguage(event.target.value)) setSetting({ language: event.target.value });
          }}>
            {LANGUAGES.map((option) => <option key={option.code} value={option.code} lang={option.code}>{option.name}</option>)}
          </Select>
        </SettingRow>
      </SettingsGroup>}
      {section === 1 && <SettingsGroup>
          <SettingRow title={tr("Rozmiar czcionki terminala (nowe komórki)")} htmlFor="settings-font-size" hint={tr('Dotyczy nowo otwieranych komórek terminala.')}>
            <input id="settings-font-size" className="input" type="number" min={8} max={32} value={s.settings.fontSize} style={{ width: 72 }}
              onChange={(e) => setSetting({ fontSize: Math.max(8, Math.min(32, Number(e.target.value) || 13)) })} />
          </SettingRow>
          <SettingRow title={tr("Shell")} htmlFor="settings-shell" hint={tr('Powłoka uruchamiana w nowych komórkach shell.')}>
            <Select id="settings-shell" className="select" value={s.settings.shell} onChange={(e) => setSetting({ shell: e.target.value as ShellKind })}>
              {shellsForPlatform(window.mc.platform).map((shell) => <option key={shell.code} value={shell.code}>{shell.name}</option>)}
            </Select>
          </SettingRow>
        <SettingRow title={tr('Wczytywanie sesji w tle po uruchomieniu')} htmlFor="settings-background-load" hint={tr(BACKGROUND_HINT[s.settings.backgroundLoad], { max: BACKGROUND_MAX_CELLS })}>
          <Select id="settings-background-load" className="select" value={s.settings.backgroundLoad}
            onChange={(e) => setSetting({ backgroundLoad: normalizeBackgroundLoad(e.target.value) })}>
            {BACKGROUND_LOAD_MODES.map((mode) => <option key={mode} value={mode}>{tr(BACKGROUND_LABEL[mode])}</option>)}
          </Select>
        </SettingRow>
      </SettingsGroup>}
      {section === 2 && <AlertsSettings />}
      {section === 3 && <SettingsGroup>
        <SettingRow title={tr('Sposób instalowania aktualizacji')} htmlFor="settings-updates" hint={{
            manual: tr('Aplikacja startuje od razu. Aktualizacje pobierają się w tle, a przycisk w stopce zainstaluje je, gdy zechcesz.'),
            ask: tr('Przy starcie aplikacja sprawdza aktualizacje i pyta, czy zainstalować od razu. Pobieranie rusza w tle już podczas pytania. „Później” uruchamia obecną wersję, a przycisk w stopce zainstaluje aktualizację.'),
          }[s.settings.updateMode]}>
          <Select id="settings-updates" className="select" value={s.settings.updateMode}
            onChange={(e) => setSetting({ updateMode: normalizeUpdateMode(e.target.value) })}>
            <option value="ask">{tr('Automatycznie')}</option>
            <option value="manual">{tr('Ręcznie')}</option>
          </Select>
        </SettingRow>
      </SettingsGroup>}
      {section === 4 && <SettingsGroup>
        <SettingRow title={tr('Pokazuj limity kont AI')} htmlFor="settings-ai-usage" hint={tr('Pasek zużycia limitów Claude i Codex w panelu bocznym.')}>
          <input id="settings-ai-usage" className="setting-switch" type="checkbox" role="switch" checked={s.settings.showAiUsage} onChange={(e) => setSetting({ showAiUsage: e.target.checked })} />
        </SettingRow>
        <SettingRow title={tr('Odświeżanie limitów')} htmlFor="settings-usage-interval" hint={tr('Jak często odświeżać zużycie limitów.')}>
          <Select id="settings-usage-interval" className="select" value={s.settings.usageIntervalMinutes}
            onChange={(e) => setSetting({ usageIntervalMinutes: Number(e.target.value) })}>
            {USAGE_INTERVALS_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{tr('co {count} min', { count: minutes })}</option>)}
          </Select>
        </SettingRow>
      </SettingsGroup>}
      {section === 5 && <>
        <p className="settings-group-desc">{tr('Profil to gotowy sposób uruchamiania agenta: wybierasz polecenie (Claude, Codex lub zwykła powłoka), nazwę, kolor i opcje startowe. Każda nowa komórka z tym profilem startuje z tymi opcjami.')}</p>
        {s.profiles.map((p) => (
          <SettingsGroup key={p.id}>
            <div className="profile-card" role="group" aria-label={p.name || tr('Nowy profil')}>
              <div className="profile-head">
                <ColorPicker value={p.color} label={`${tr('Kolor')}: ${p.name}`} onChange={(color) => update((st) => upsertProfile(st, { ...p, color }))} />
                <input id={`settings-profile-name-${p.id}`} className="input profile-name" aria-label={tr('Nazwa')} value={p.name} placeholder={tr('Nazwa')} onChange={(e) => update((st) => upsertProfile(st, { ...p, name: e.target.value }))} />
                <Select id={`settings-profile-cli-${p.id}`} className="select profile-cli" aria-label="CLI" value={p.cli} onChange={(e) => update((st) => upsertProfile(st, { ...p, cli: e.target.value as CliKind }))}>
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                  <option value="shell">shell</option>
                </Select>
                <button className="btn ghost icon" aria-label={tr('Usuń profil')} title={tr("Usuń profil")} onClick={() => update((st) => removeProfile(st, p.id))}><IX /></button>
              </div>
              <ProfileOptions profile={p} onChange={(args) => update((st) => upsertProfile(st, { ...p, args }))} />
            </div>
          </SettingsGroup>
        ))}
        <div>
          <button className="btn" onClick={() => update((st) => upsertProfile(st, { id: uid(), name: tr("Nowy profil"), cli: 'claude', args: '', color: '#8b5cf6' }))}>{tr("+ Dodaj profil")}</button>
        </div>
      </>}
      {section === 6 && <SettingsGroup><ShortcutsSettings /></SettingsGroup>}
      </div>
    </div>
  </div>;
}
