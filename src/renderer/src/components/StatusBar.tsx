import { useState } from 'react';
import { useI18n } from '../i18n';
import { setUi } from '../store';
import { BackgroundLoadHint } from './BackgroundLoadHint';
import { IChangelog } from './icons';
import { RefreshIcon, useHoldBusy } from './Spinner';
import { formatUpdateBytes, requestUpdateCheck, useUpdateState } from './UpdateBadge';
import './updater.css';

/** Full-width bottom bar: running version and live update status, with the update action. */
export function StatusBar() {
  const { tr, errorText, language } = useI18n();
  const { update: u, currentVersion } = useUpdateState();
  const [clicked, setClicked] = useState(false);
  // Checking is usually instant, so keep the turning arrow visible long enough to notice.
  const checking = useHoldBusy(u.status === 'checking' || clicked, 800);
  const check = () => { setClicked(true); requestUpdateCheck(); setTimeout(() => setClicked(false), 50); };
  const version = u.version ?? '';
  let currentTitle = '';

  const status = (() => {
    switch (u.status) {
      case 'current': {
        const when = u.checkedAt ? new Date(u.checkedAt).toLocaleTimeString(language) : '';
        const title = when && u.version ? tr('Ostatnie sprawdzenie: {time} · najnowsza wersja: {version}', { time: when, version: u.version }) : tr('Sprawdź aktualizacje');
        currentTitle = `${tr('Masz najnowszą wersję')} · ${title}`;
        return null;
      }
      case 'downloading': {
        const percent = Math.round(Math.min(100, Math.max(0, Number.isFinite(u.percent) ? u.percent! : 0)));
        const progress = <>
          {tr('Pobieranie {version}… {percent}%', { version, percent })}
          <span className="sb-track" role="progressbar" aria-label={tr('Pobieranie aktualizacji w tle')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></span>
          <span className="sb-transfer">{formatUpdateBytes(u.transferred)} / {formatUpdateBytes(u.total)} · {formatUpdateBytes(u.bytesPerSecond)}/s</span>
        </>;
        // The download runs in the background; a click opens the one update window, which finishes the download and installs.
        return u.portable
          ? <span className="sb-item" role="status" title={tr('Pobieranie aktualizacji w tle')}>{progress}</span>
          : <button className="sb-btn sb-action" onClick={() => window.mc.installUpdate()} title={tr('Kliknij, aby otworzyć okno aktualizacji - zainstaluje się po pobraniu')}>{progress}</button>;
      }
      case 'ready':
        return <button className="sb-btn sb-action" onClick={() => window.mc.installUpdate()} title={tr('Aktualizacja potrwa chwilę, rozmowy wznowią się same')}><span className="sb-dot new" aria-hidden />{tr('Wersja {version} gotowa - Zainstaluj', { version })}</button>;
      case 'available':
        // Without in-app installation (portable build, macOS app that cannot replace itself) only the download page is offered.
        if (!u.portable) return <button className="sb-btn sb-action" onClick={() => window.mc.installUpdate()} title={tr('Aktualizacja potrwa chwilę, rozmowy wznowią się same')}><span className="sb-dot new" aria-hidden />{tr('Dostępna wersja {version} - Aktualizuj', { version })}</button>;
        return <button className="sb-btn sb-action" onClick={() => window.mc.openReleases()} title={u.message ? errorText(u.message) : tr('Otwórz stronę pobierania')}><span className="sb-dot new" aria-hidden />{tr('Nowa wersja {version} · pobierz', { version })}</button>;
      case 'unavailable':
        return <span className="sb-item sb-muted" role="status">{errorText(u.message ?? '')}</span>;
      case 'installing':
        return <span className="sb-item" role="status"><RefreshIcon spinning />{tr('Instalowanie {version}…', { version })}</span>;
      case 'error': {
        const message = errorText(u.message ?? 'Nie udało się sprawdzić aktualizacji.');
        return <span className="sb-item sb-error" role="alert">
          <button className="sb-btn" onClick={check}>{tr('Błąd aktualizacji · ponów')}</button>
          <span className="sb-message" title={message}>{message}</span>
        </span>;
      }
      default:
        return <button className="sb-btn" onClick={check}>{tr('Sprawdź aktualizacje')}</button>;
    }
  })();

  const dot = u.status === 'current' ? 'ok' : ['available', 'ready', 'downloading'].includes(u.status) ? 'new' : u.status === 'error' ? 'err' : '';
  const shown = checking && !['downloading', 'ready', 'available', 'installing', 'error', 'unavailable'].includes(u.status)
    ? <span className="sb-item" role="status"><RefreshIcon spinning />{tr('Sprawdzanie aktualizacji…')}</span>
    : status;
  return (
    <footer className="statusbar">
      {currentVersion && <button className="sb-version" onClick={check} title={currentTitle || `${tr('Wersja {version}', { version: currentVersion })} · ${tr('Sprawdź aktualizacje')}`} aria-label={`${tr('Wersja {version}', { version: currentVersion })}. ${tr('Sprawdź aktualizacje')}`}>
        <span className={`sb-dot ${dot}`} aria-hidden />v{currentVersion}
      </button>}
      {shown}
      <BackgroundLoadHint />
      <span className="sb-spacer" />
      <button className="sb-btn" onClick={() => setUi({ modal: { kind: 'changelog' } })} title={tr('Co nowego')} aria-label={tr('Co nowego')}><IChangelog />{tr('Co nowego')}</button>
    </footer>
  );
}
