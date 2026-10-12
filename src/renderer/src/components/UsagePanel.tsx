import { useEffect, useRef, useState } from 'react';
import { updateSettings } from '../../../shared/state';
import type { LoginTarget } from '../../../shared/accounts';
import { effectivePercent, formatDuration, shortAccountName, shortDuration, summaryAccounts, usageBand, usageSummary, worstPercent, type ProviderUsage, type UsageProvider, type UsageWindow } from '../../../shared/usage';
import { useI18n } from '../i18n';
import { swapErrorKey } from '../../../shared/swapMessages';
import { askChoice, setUi, toast, update, useStore } from '../store';
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

function AccountCard({ usage, now, language, showMain, swapping, onMakeMain }: {
  usage: ProviderUsage; now: number; language: string; showMain: boolean;
  /** Account id whose swap is running (any card is locked meanwhile), or null. */
  swapping: string | null; onMakeMain: (usage: ProviderUsage) => void;
}) {
  const { tr } = useI18n();
  const busy = swapping !== null;
  // On macOS Claude keeps its tokens in the Keychain, so the main login cannot be exchanged there.
  const canMakeMain = usage.managed && usage.provider === 'claude' && window.mc.platform !== 'darwin';
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
    try {
      const result = await window.mc.removeAccount(usage.accountId.replace(/^claude:/, ''));
      if (!result.ok && result.error) toast(tr(swapErrorKey(result.error)), 'error');
    } catch { /* the next usage refresh shows the real state */ }
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
    <div className={`usage-card ${expired ? 'expired' : ''} ${swapping === usage.accountId ? 'busy' : ''}`} title={usage.org || undefined} aria-busy={swapping === usage.accountId || undefined}>
      <div className="usage-card-head">
        <ProviderIcon provider={usage.provider} />
        <span className="usage-account" title={name}>{name}</span>
        {usage.plan && <span className="usage-chip">{usage.plan}</span>}
        {showMain && usage.accountId === 'claude:main' && <span className="usage-chip main">{tr('główne')}</span>}
        {swapping === usage.accountId && (
          <span className="usage-swapping" role="status" aria-live="polite">
            <span className="usage-spinner" aria-hidden="true" />
            {tr('Przełączam konto…')}
          </span>
        )}
        {usage.managed && swapping !== usage.accountId && (
          <button
            className="usage-kebab"
            aria-haspopup="menu"
            aria-label={tr('Usuń konto')}
            title={tr('Usuń konto')}
            onClick={(e) => openMenuAt(e.currentTarget, [
              ...(canMakeMain ? [{ label: tr('Ustaw jako główne'), disabled: busy, onClick: () => onMakeMain(usage) }] : []),
              { label: tr('Usuń konto'), danger: true, disabled: busy, onClick: () => void removeAccount() },
            ])}
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
  const [swapping, setSwapping] = useState<string | null>(null);
  const [swapPending, setSwapPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // An interrupted swap blocks further swaps until the user has checked the accounts and cleared the warning.
  useEffect(() => {
    void window.mc.swapPending().then((pending) => { if (alive.current) setSwapPending(pending); }).catch(() => undefined);
    return window.mc.on('accounts:swapPending', (pending) => { if (alive.current) setSwapPending(pending); });
  }, []);
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
  const clearWarning = async () => {
    const choice = await askChoice(
      tr('Wyczyścić ostrzeżenie?'),
      tr('Kopia awaryjna poprzedniej zamiany (z danymi logowania) zostanie usunięta na stałe, a zamiany kont zostaną odblokowane. Zrób to dopiero po sprawdzeniu, że oba konta działają.'),
      [{ label: tr('Wyczyść ostrzeżenie'), value: 'yes', danger: true }],
    );
    if (choice !== 'yes') return;
    try {
      const result = await window.mc.clearSwapPending();
      if (result.ok && alive.current) setSwapPending(false);
    } catch { /* the warning stays */ }
  };
  const makeMain = async (target: ProviderUsage) => {
    if (swapping !== null) return;
    const current = providers.find((usage) => usage.accountId === 'claude:main')?.email || tr('obecne konto główne');
    const name = target.email || NAMES.claude;
    const exhausted = target.windows.some((window) => effectivePercent(window, Date.now()) >= 100);
    const body = tr('Obecne konto główne ({current}) zostanie zachowane jako zapisane konto, a wybrane stanie się głównym logowaniem Claude Code. Token wybranego konta jest przed zamianą odświeżany w Anthropic, a pliki logowania są wymieniane na tym komputerze. Otwarte sesje Claude zwykle przejmują nowe logowanie przy następnej wiadomości, ale zależy to od wersji Claude Code - sesję, która tego nie zrobi, wystarczy zrestartować lub wznowić.', { current })
      + (exhausted ? `\n\n${tr('Limity tego konta są wyczerpane (100%), więc sesje mogą nie działać do czasu resetu.')}` : '');
    const choice = await askChoice(tr('Ustawić {name} jako konto główne?', { name }), body, [{ label: tr('Ustaw jako główne'), value: 'yes', primary: true }]);
    if (choice !== 'yes') return;
    setSwapping(target.accountId);
    try {
      const result = await window.mc.makeMainAccount(target.accountId.replace(/^claude:/, ''));
      if (result.ok) toast(result.email ? tr('Konto główne: {email}', { email: result.email }) : tr('Zmieniono konto główne.'));
      else toast(tr(swapErrorKey(result.error)), 'error');
    } catch {
      toast(tr('Nie udało się zmienić konta głównego.'), 'error');
    } finally {
      if (alive.current) setSwapping(null);
    }
  };
  const summary = usageSummary(providers, now) || tr('Konta AI');
  // Tooltip of one account: name plus every window, e.g. "Claude · 5 h 12% · 7 days 40%".
  const accountDetail = (usage: ProviderUsage, nowMs: number) => [
    usage.email || NAMES[usage.provider],
    ...usage.windows.map((window) => `${window.id === '5h' ? tr('5 godz.') : tr('7 dni')} ${Math.round(effectivePercent(window, nowMs))}%`),
  ].join(' · ');
  const updated = visible.length ? new Date(Math.max(...visible.map((usage) => usage.fetchedAt))).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) : '';
  const claudeCount = visible.filter((usage) => usage.provider === 'claude').length;
  const hasCodex = visible.some((usage) => usage.provider === 'codex');
  // On macOS Claude keeps its tokens in the Keychain, so isolated profiles cannot work there.
  const canAddClaude = window.mc.platform !== 'darwin';

  if (rail) {
    if (!shown.length) return null;
    return (
      <div className="usage-panel usage-rail" title={summary}>
        {shown.map((usage) => (
          <div key={usage.accountId} className="usage-rail-item" title={accountDetail(usage, now)}>
            <ProviderIcon provider={usage.provider} size={14} />
            {usage.windows.map((window) => {
              const percent = effectivePercent(window, now);
              return (
                <div key={window.id} className="usage-rail-win">
                  <span className="usage-rail-line"><span>{window.id === '5h' ? '5h' : '7d'}</span><span>{Math.round(percent)}</span></span>
                  <Bar percent={percent} label={`${usage.email || NAMES[usage.provider]} ${window.id === '5h' ? tr('5 godz.') : tr('7 dni')}`} />
                </div>
              );
            })}
          </div>
        ))}
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
          {/* The chevron points where the panel goes: up to expand, down to collapse. */}
          <span className={`usage-chevron ${collapsed ? 'up' : ''}`}><IChevron /></span>
          {tr('Limity kont AI')}
        </button>
        <button className="btn ghost icon" onClick={(e) => openAddMenu(e.currentTarget)} title={tr('Dodaj konto')} aria-label={tr('Dodaj konto')}><IPlus /></button>
        <button className="btn ghost icon" onClick={() => void refresh()} disabled={spinning} title={tr('Odśwież limity')} aria-label={tr('Odśwież limity')}><RefreshIcon spinning={spinning} /></button>
      </div>
      {collapsed && (shown.length ? (
        <div className="usage-mini-list">
          {shown.map((usage) => {
            const label = usage.provider === 'claude' && claudeCount > 1 ? shortAccountName(usage.email, NAMES.claude, 7) : '';
            return (
              <div key={usage.accountId} className="usage-mini" title={accountDetail(usage, now)}>
                <span className="usage-mini-who">
                  <ProviderIcon provider={usage.provider} size={12} />
                  {label && <span className="usage-mini-name">{label}</span>}
                </span>
                <span className="usage-mini-wins">
                  {usage.windows.map((window) => {
                    const percent = effectivePercent(window, now);
                    const upcoming = window.resetsAt * 1000 > now;
                    return (
                      <span key={window.id} className="usage-mini-win">
                        <span className="usage-mini-tag">{window.id === '5h' ? '5h' : '7d'}</span>
                        <span className="usage-mini-bar"><Bar percent={percent} label={`${usage.email || NAMES[usage.provider]} ${window.id === '5h' ? tr('5 godz.') : tr('7 dni')}`} /></span>
                        <span className="usage-mini-pct">{Math.round(percent)}%</span>
                        <span className="usage-mini-reset">{upcoming ? shortDuration(window.resetsAt - now / 1000) : ''}</span>
                      </span>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
      ) : <p className="usage-note">{summary}</p>)}
      {!collapsed && (
        <>
          {swapPending && (
            <div className="usage-warning" role="alert">
              <p className="usage-note">{tr('Poprzednia zamiana kont została przerwana. Konta mogą wymagać ponownego zalogowania: sprawdź oba konta, a po wyczyszczeniu ostrzeżenia zaloguj się ponownie na każde, które przestało działać (logowanie Claude zawsze można wykonać od nowa). Do czasu wyczyszczenia ostrzeżenia kolejne zamiany są zablokowane.')}</p>
              <button className="btn small" onClick={() => void clearWarning()}>{tr('Wyczyść ostrzeżenie')}</button>
            </div>
          )}
          {visible.length ? (
            <>
              {visible.map((usage) => <AccountCard key={usage.accountId} usage={usage} now={now} language={language} showMain={claudeCount > 1} swapping={swapping} onMakeMain={(target) => void makeMain(target)} />)}
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
