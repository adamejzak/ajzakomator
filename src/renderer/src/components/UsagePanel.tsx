import { useEffect, useRef, useState } from 'react';
import { updateSettings } from '../../../shared/state';
import type { LoginTarget } from '../../../shared/accounts';
import { effectivePercent, formatDuration, summaryAccounts, usageBand, usageSummary, worstPercent, type ProviderUsage, type UsageProvider, type UsageWindow } from '../../../shared/usage';
import { useI18n } from '../i18n';
import { askChoice, setUi, update, useStore } from '../store';
import { useUsage } from '../usage';
import { openMenuAt } from './ContextMenu';
import { IChevron, IPlus } from './icons';
import { ProviderIcon } from './ProviderIcons';
import { RefreshIcon, useHoldBusy } from './Spinner';

const NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' };

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

const openAuth = (provider: UsageProvider, target: LoginTarget) => setUi({ modal: { kind: 'auth', provider, target } });

/** The login target that renews this account. */
function reloginTarget(usage: ProviderUsage): LoginTarget {
  return usage.managed && usage.provider === 'claude' ? { type: 'account', id: usage.accountId.replace(/^claude:/, '') } : { type: 'main' };
}

function KebabIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden><circle cx="8" cy="3.5" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="8" cy="12.5" r="1.2" /></svg>;
}

function AccountCard({ usage, now, language, showMain }: { usage: ProviderUsage; now: number; language: string; showMain: boolean }) {
  const { tr } = useI18n();
  const providerName = NAMES[usage.provider];
  const name = usage.email || providerName;
  const age = formatDuration((now - usage.fetchedAt) / 1000);
  const expired = usage.status === 'expired';
  const removeAccount = async () => {
    const choice = await askChoice(
      tr('Usunąć konto {name}?', { name }),
      tr('Logowanie zostanie usunięte z aplikacji. Samo konto pozostaje bez zmian.'),
      [{ label: tr('Usuń konto'), value: 'yes', danger: true }],
    );
    if (choice !== 'yes') return;
    try { await window.mc.removeAccount(usage.accountId.replace(/^claude:/, '')); } catch { /* the next usage refresh shows the real state */ }
  };

  let body;
  if (expired) {
    body = (
      <div className="usage-expired">
        <span className="usage-note">{tr('Logowanie wygasło')}</span>
        <button className="btn small primary" onClick={() => openAuth(usage.provider, reloginTarget(usage))}>{tr('Zaloguj ponownie')}</button>
      </div>
    );
  } else if (usage.status === 'apiKey') {
    body = <p className="usage-note">{tr('Codex: logowanie kluczem API, brak limitów.')}</p>;
  } else if (!usage.windows.length) {
    body = <p className="usage-note warn">{tr('{name}: nie udało się odczytać limitów.', { name: providerName })}</p>;
  } else {
    const failed = usage.status === 'error';
    const ageNote = usage.source === 'log' ? tr('stan z ostatniej sesji, sprzed {age}', { age })
      : usage.source === 'cache' ? tr('dane sprzed {age}', { age }) : '';
    const hint = failed ? tr('{name}: nie udało się odczytać limitów.', { name: providerName }) : ageNote;
    body = (
      <>
        {usage.windows.map((window) => <WindowRow key={window.id} window={window} now={now} language={language} />)}
        {hint && <p className={`usage-note ${failed ? 'warn' : ''}`}>{failed && ageNote ? `${hint} (${ageNote})` : hint}</p>}
      </>
    );
  }

  return (
    <div className={`usage-card ${expired ? 'expired' : ''}`} title={usage.org || undefined}>
      <div className="usage-card-head">
        <ProviderIcon provider={usage.provider} />
        <span className="usage-account" title={name}>{name}</span>
        {usage.plan && <span className="usage-chip">{usage.plan}</span>}
        {showMain && usage.accountId === 'claude:main' && <span className="usage-chip main">{tr('główne')}</span>}
        {usage.managed && (
          <button
            className="usage-kebab"
            aria-haspopup="menu"
            aria-label={tr('Usuń konto')}
            title={tr('Usuń konto')}
            onClick={(e) => openMenuAt(e.currentTarget, [{ label: tr('Usuń konto'), danger: true, onClick: () => void removeAccount() }])}
          ><KebabIcon /></button>
        )}
      </div>
      {body}
    </div>
  );
}

/** Fixed section above the status bar: limits of the connected Claude and Codex accounts. */
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

  const visible = providers.filter((usage) => usage.status !== 'signedOut');
  const shown = summaryAccounts(providers);
  const refresh = async () => {
    setRefreshing(true);
    try { await window.mc.refreshUsage(); } catch { /* the next scheduled refresh retries */ } finally { if (alive.current) setRefreshing(false); }
  };
  const summary = usageSummary(providers, now) || tr('Konta AI');
  const updated = visible.length ? new Date(Math.max(...visible.map((usage) => usage.fetchedAt))).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) : '';
  const claudeCount = visible.filter((usage) => usage.provider === 'claude').length;
  const hasCodex = visible.some((usage) => usage.provider === 'codex');
  // On macOS Claude keeps its tokens in the Keychain, so isolated profiles cannot work there.
  const canAddClaude = window.mc.platform !== 'darwin';

  if (rail) {
    if (!shown.length) return null;
    return (
      <div className="usage-panel usage-rail" title={summary}>
        {shown.map((usage) => {
          const percent = worstPercent(usage, now);
          return (
            <div key={usage.accountId} className="usage-rail-item">
              <ProviderIcon provider={usage.provider} size={14} />
              <Bar percent={percent} label={usage.email || NAMES[usage.provider]} />
              <span>{Math.round(percent)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  const collapsed = settings.usageCollapsed;
  const toggle = () => update((st) => updateSettings(st, { usageCollapsed: !collapsed }));
  const openAddMenu = (el: HTMLElement) => openMenuAt(el, [
    ...(canAddClaude ? [{ label: tr('Dodaj konto Claude'), onClick: () => openAuth('claude', { type: 'new' }) }] : []),
    ...(hasCodex ? [] : [{ label: tr('Zaloguj się do Codex'), onClick: () => openAuth('codex', { type: 'main' }) }]),
  ]);
  return (
    <section className="usage-panel" aria-label={tr('Limity kont AI')}>
      <div className="usage-head">
        <button className="usage-title" onClick={toggle} aria-expanded={!collapsed} title={collapsed ? tr('Rozwiń limity kont AI') : tr('Zwiń limity kont AI')}>
          <span className={`usage-chevron ${collapsed ? '' : 'open'}`}><IChevron /></span>
          {collapsed ? <span className="usage-summary">{summary}</span> : tr('Limity kont AI')}
        </button>
        <button className="btn ghost icon" onClick={(e) => openAddMenu(e.currentTarget)} title={tr('Dodaj konto')} aria-label={tr('Dodaj konto')}><IPlus /></button>
        <button className="btn ghost icon" onClick={() => void refresh()} disabled={spinning} title={tr('Odśwież limity')} aria-label={tr('Odśwież limity')}><RefreshIcon spinning={spinning} /></button>
      </div>
      {!collapsed && (
        <>
          {visible.length ? (
            <>
              {visible.map((usage) => <AccountCard key={usage.accountId} usage={usage} now={now} language={language} showMain={claudeCount > 1} />)}
              {updated && <p className="usage-note">{tr('Zaktualizowano {time}', { time: updated })}</p>}
            </>
          ) : (
            <div className="usage-empty">
              <p className="usage-note">{tr('Brak podłączonych kont. Dodaj konto, aby zobaczyć limity.')}</p>
              <div className="usage-empty-buttons">
                {canAddClaude && <button className="btn small" onClick={() => openAuth('claude', { type: 'new' })}><ProviderIcon provider="claude" size={14} />Claude</button>}
                <button className="btn small" onClick={() => openAuth('codex', { type: 'main' })}><ProviderIcon provider="codex" size={14} />Codex</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
