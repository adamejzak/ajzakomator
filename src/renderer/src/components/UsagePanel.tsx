import { useEffect, useRef, useState } from 'react';
import { updateSettings } from '../../../shared/state';
import { effectivePercent, formatDuration, usageBand, worstPercent, type ProviderUsage, type UsageProvider, type UsageWindow } from '../../../shared/usage';
import { useI18n } from '../i18n';
import { update, useStore } from '../store';
import { useUsage } from '../usage';
import { IChevron } from './icons';
import { RefreshIcon, useHoldBusy } from './Spinner';

const NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' };
const COMMANDS: Record<UsageProvider, string> = { claude: 'claude', codex: 'codex' };
const CLIS: Record<UsageProvider, string> = { claude: 'Claude Code', codex: 'Codex' };
const RAIL: Record<UsageProvider, string> = { claude: 'Cl', codex: 'Cx' };

function Bar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="usage-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <span className={usageBand(percent)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function WindowRow({ window, now, language }: { window: UsageWindow; now: number; language: string }) {
  const { tr } = useI18n();
  const percent = effectivePercent(window, now);
  const upcoming = window.resetsAt * 1000 > now;
  const at = new Date(window.resetsAt * 1000);
  const clock = window.id === '5h'
    ? at.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(language, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="usage-row">
      <span className="usage-label">{window.id === '5h' ? tr('5 godz.') : tr('7 dni')}</span>
      <Bar percent={percent} label={window.id === '5h' ? tr('5 godz.') : tr('7 dni')} />
      <span className="usage-pct">{Math.round(percent)}%</span>
      {upcoming && <span className="usage-reset">{tr('reset {time}', { time: clock })} · {tr('za {time}', { time: formatDuration(window.resetsAt - now / 1000) })}</span>}
    </div>
  );
}

function Provider({ usage, now, language }: { usage: ProviderUsage; now: number; language: string }) {
  const { tr } = useI18n();
  const name = NAMES[usage.provider];
  const age = formatDuration((now - usage.fetchedAt) / 1000);
  if (usage.status === 'signedOut') return <p className="usage-note">{tr('{name}: nie zalogowano. Uruchom {command} w terminalu.', { name, command: COMMANDS[usage.provider] })}</p>;
  if (usage.status === 'apiKey') return <p className="usage-note">{tr('Codex: logowanie kluczem API, brak limitów.')}</p>;
  const stale = usage.status === 'expired' || usage.status === 'error';
  if (!usage.windows.length) {
    return <p className="usage-note warn">{usage.status === 'expired'
      ? tr('{name}: otwórz {command}, aby odświeżyć logowanie.', { name, command: CLIS[usage.provider] })
      : tr('{name}: nie udało się odczytać limitów.', { name })}</p>;
  }
  const hint = stale ? (usage.status === 'expired'
    ? tr('{name}: otwórz {command}, aby odświeżyć logowanie.', { name, command: CLIS[usage.provider] })
    : tr('{name}: nie udało się odczytać limitów.', { name }))
    : usage.source === 'log' ? tr('stan z ostatniej sesji, sprzed {age}', { age })
    : usage.source === 'cache' ? tr('dane sprzed {age}', { age }) : '';
  return (
    <div className="usage-provider">
      <div className="usage-name">{name}{usage.plan && <span className="usage-plan">{usage.plan}</span>}{usage.email && <span className="usage-plan" title={usage.email}>{usage.email}</span>}</div>
      {usage.windows.map((window) => <WindowRow key={window.id} window={window} now={now} language={language} />)}
      {hint && <p className={`usage-note ${stale ? 'warn' : ''}`}>{stale && usage.source === 'cache' ? `${hint} (${tr('dane sprzed {age}', { age })})` : hint}</p>}
    </div>
  );
}

/** Fixed section above the status bar: limits of the signed-in Claude and Codex accounts. */
export function UsagePanel() {
  const { tr, language } = useI18n();
  const settings = useStore((st) => st.s.settings);
  const rail = useStore((st) => st.s.sidebarCollapsed);
  const { providers } = useUsage();
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const spinning = useHoldBusy(refreshing, 700);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (!settings.showAiUsage) return null;

  const signedIn = providers.filter((usage) => usage.status !== 'signedOut' && usage.status !== 'apiKey');
  const refresh = async () => {
    setRefreshing(true);
    try { await window.mc.refreshUsage(); } catch { /* the next scheduled refresh retries */ } finally { if (alive.current) setRefreshing(false); }
  };
  const summary = signedIn.length
    ? signedIn.map((usage) => `${NAMES[usage.provider]} ${Math.round(worstPercent(usage, now))}%`).join(' · ')
    : tr('Konta AI');
  const known = providers.filter((usage) => usage.status !== 'signedOut');
  const updated = known.length ? new Date(Math.max(...known.map((usage) => usage.fetchedAt))).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) : '';

  if (rail) {
    if (!signedIn.length) return null;
    return (
      <div className="usage-panel usage-rail" title={summary}>
        {signedIn.map((usage) => {
          const percent = worstPercent(usage, now);
          return (
            <div key={usage.provider} className="usage-rail-item">
              <span>{RAIL[usage.provider]}</span>
              <Bar percent={percent} label={NAMES[usage.provider]} />
              <span>{Math.round(percent)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  const collapsed = settings.usageCollapsed;
  const toggle = () => update((st) => updateSettings(st, { usageCollapsed: !collapsed }));
  return (
    <section className="usage-panel" aria-label={tr('Limity kont AI')}>
      <div className="usage-head">
        <button className="usage-title" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? tr('Rozwiń limity kont AI') : tr('Zwiń limity kont AI')}>
          <span className={`usage-chevron ${collapsed ? '' : 'open'}`}><IChevron /></span>
          {collapsed ? <span className="usage-summary">{summary}</span> : tr('Limity kont AI')}
        </button>
        <button className="btn ghost icon" onClick={() => void refresh()} disabled={spinning} title={tr('Odśwież limity')} aria-label={tr('Odśwież limity')}><RefreshIcon spinning={spinning} /></button>
      </div>
      {!collapsed && (
        <>
          {known.length
            ? providers.map((usage) => <Provider key={usage.provider} usage={usage} now={now} language={language} />)
            : <p className="usage-note">{tr('Zaloguj się w Claude Code lub Codexie, aby zobaczyć limity.')}</p>}
          {updated && <p className="usage-note">{tr('Zaktualizowano {time}', { time: updated })}</p>}
        </>
      )}
    </section>
  );
}
