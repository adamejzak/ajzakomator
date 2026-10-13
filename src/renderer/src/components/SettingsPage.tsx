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
      <div className="settings-card">
      {section === 0 && <>
        <div className="field language-setting">
          <label htmlFor="settings-language">{tr('Język aplikacji')}</label>
          <select id="settings-language" className="select" value={language} onChange={(event) => {
            if (isLanguage(event.target.value)) setSetting({ language: event.target.value });
          }}>
            {LANGUAGES.map((option) => <option key={option.code} value={option.code} lang={option.code}>{option.name}</option>)}
          </select>
          <span className="muted">{tr('Zmiana języka działa od razu.')}</span>
        </div>
      </>}
      {section === 1 && <>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <div className="field">
            <label htmlFor="settings-font-size">{tr("Rozmiar czcionki terminala (nowe komórki)")}</label>
            <input id="settings-font-size" className="input" type="number" min={8} max={32} value={s.settings.fontSize} style={{ width: 120 }}
              onChange={(e) => setSetting({ fontSize: Math.max(8, Math.min(32, Number(e.target.value) || 13)) })} />
          </div>
          <div className="field">
            <label htmlFor="settings-shell">{tr("Shell")}</label>
            <select id="settings-shell" className="select" value={s.settings.shell} onChange={(e) => setSetting({ shell: e.target.value as ShellKind })}>
              {shellsForPlatform(window.mc.platform).map((shell) => <option key={shell.code} value={shell.code}>{shell.name}</option>)}
            </select>
          </div>

        </div>
        <div className="field">
          <label htmlFor="settings-background-load">{tr('Wczytywanie sesji w tle po uruchomieniu')}</label>
          <select id="settings-background-load" className="select" style={{ width: 380, maxWidth: '100%' }} value={s.settings.backgroundLoad}
            onChange={(e) => setSetting({ backgroundLoad: normalizeBackgroundLoad(e.target.value) })}>
            {BACKGROUND_LOAD_MODES.map((mode) => <option key={mode} value={mode}>{tr(BACKGROUND_LABEL[mode])}</option>)}
          </select>
          <span className="muted">{tr(BACKGROUND_HINT[s.settings.backgroundLoad], { max: BACKGROUND_MAX_CELLS })}</span>
        </div>
      </>}
      {section === 2 && <AlertsSettings />}
      {section === 3 && <>
        <div className="field">
          <label htmlFor="settings-updates">{tr('Sposób instalowania aktualizacji')}</label>
          <select id="settings-updates" className="select" style={{ width: 380, maxWidth: '100%' }} value={s.settings.updateMode}
            onChange={(e) => setSetting({ updateMode: normalizeUpdateMode(e.target.value) })}>
            <option value="ask">{tr('Automatycznie (sprawdzaj przy starcie, pytaj przed instalacją)')}</option>
            <option value="manual">{tr('Ręcznie (przycisk w stopce)')}</option>
          </select>
          <span className="muted">{{
            manual: tr('Aplikacja startuje od razu. Aktualizacje pobierają się w tle, a przycisk w stopce zainstaluje je, gdy zechcesz.'),
            ask: tr('Przy starcie aplikacja sprawdza aktualizacje i pyta, czy zainstalować od razu. Pobieranie rusza w tle już podczas pytania. „Później” uruchamia obecną wersję, a przycisk w stopce zainstaluje aktualizację.'),
          }[s.settings.updateMode]}</span>
        </div>
      </>}
      {section === 4 && <>
        <label className="check">
          <input type="checkbox" checked={s.settings.showAiUsage} onChange={(e) => setSetting({ showAiUsage: e.target.checked })} />
          {tr('Pokazuj limity kont AI')}
        </label>
        <div className="field">
          <label htmlFor="settings-usage-interval">{tr('Odświeżanie limitów')}</label>
          <select id="settings-usage-interval" className="select" style={{ width: 200 }} value={s.settings.usageIntervalMinutes}
            onChange={(e) => setSetting({ usageIntervalMinutes: Number(e.target.value) })}>
            {USAGE_INTERVALS_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{tr('co {count} min', { count: minutes })}</option>)}
          </select>
        </div>
      </>}
      {section === 5 && <>
        <div className="muted" style={{ fontSize: 11.5 }}>

          {tr("Argumenty są dopisywane do polecenia, np.")} <code>--model opus</code>, <code>--dangerously-skip-permissions</code>, <code>-m gpt-5 -c model_reasoning_effort=high</code>.
        </div>
        {s.profiles.map((p) => (
          <div key={p.id} className="row settings-profile-row" role="group" aria-label={p.name || tr('Nowy profil')}>
            <input type="color" aria-label={tr('Kolor')} title={tr('Kolor')} value={p.color} onChange={(e) => update((st) => upsertProfile(st, { ...p, color: e.target.value }))}
              style={{ width: 28, height: 28, padding: 0, border: 0, background: 'none' }} />
            <input className="input" aria-label={tr('Nazwa')} style={{ width: 150 }} value={p.name} onChange={(e) => update((st) => upsertProfile(st, { ...p, name: e.target.value }))} />
            <select className="select" aria-label="CLI" value={p.cli} onChange={(e) => update((st) => upsertProfile(st, { ...p, cli: e.target.value as CliKind }))}>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="shell">shell</option>
            </select>
            <input className="input" aria-label={tr('argumenty CLI')} style={{ flex: '1 1 220px', minWidth: 0, fontFamily: 'Cascadia Mono, Consolas, monospace' }} placeholder={tr("argumenty CLI")} value={p.args}
              disabled={p.cli === 'shell'} onChange={(e) => update((st) => upsertProfile(st, { ...p, args: e.target.value }))} />
            <button className="btn ghost icon" aria-label={tr('Usuń profil')} title={tr("Usuń profil")} onClick={() => update((st) => removeProfile(st, p.id))}><IX /></button>
          </div>
        ))}
        <div>
          <button className="btn" onClick={() => update((st) => upsertProfile(st, { id: uid(), name: tr("Nowy profil"), cli: 'claude', args: '', color: '#8b5cf6' }))}>{tr("+ Dodaj profil")}</button>
        </div>
      </>}
      {section === 6 && <ShortcutsSettings />}
      </div>
    </div>
  </div>;
}
