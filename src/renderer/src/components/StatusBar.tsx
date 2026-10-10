import { useI18n } from '../i18n';
import { formatUpdateBytes, requestUpdateCheck, useUpdateState } from './UpdateBadge';
import './updater.css';

/** Full-width bottom bar: running version and live update status, with the update action. */
export function StatusBar() {
  const { tr, errorText } = useI18n();
  const { update: u, currentVersion } = useUpdateState();
  const version = u.version ?? '';

  const status = (() => {
    switch (u.status) {
      case 'checking':
        return <span className="sb-item" role="status"><span className="updater-spinner" aria-hidden />{tr('Sprawdzanie aktualizacji…')}</span>;
      case 'current':
        return <button className="sb-btn" onClick={requestUpdateCheck} title={tr('Sprawdź aktualizacje')}><span className="sb-dot ok" aria-hidden />{tr('Masz najnowszą wersję')}</button>;
      case 'downloading': {
        const percent = Math.round(Math.min(100, Math.max(0, Number.isFinite(u.percent) ? u.percent! : 0)));
        return <span className="sb-item" role="status" title={tr('Pobieranie aktualizacji w tle')}>
          {tr('Pobieranie {version}… {percent}%', { version, percent })}
          <span className="sb-track" role="progressbar" aria-label={tr('Pobieranie aktualizacji w tle')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></span>
          <span className="sb-transfer">{formatUpdateBytes(u.transferred)} / {formatUpdateBytes(u.total)} · {formatUpdateBytes(u.bytesPerSecond)}/s</span>
        </span>;
      }
      case 'ready':
        return <button className="sb-btn sb-action" onClick={() => window.mc.installUpdate()} title={tr('Zainstaluj i uruchom ponownie (rozmowy wznowią się same)')}><span className="sb-dot new" aria-hidden />{tr('Nowa wersja {version} · uruchom ponownie', { version })}</button>;
      case 'available':
        return <button className="sb-btn sb-action" onClick={() => window.mc.openReleases()} title={tr('Otwórz stronę pobierania')}><span className="sb-dot new" aria-hidden />{tr('Nowa wersja {version} · pobierz', { version })}</button>;
      case 'installing':
        return <span className="sb-item" role="status"><span className="updater-spinner" aria-hidden />{tr('Instalowanie aktualizacji…')}</span>;
      case 'error': {
        const message = errorText(u.message ?? 'Nie udało się sprawdzić aktualizacji.');
        return <span className="sb-item sb-error" role="alert">
          <button className="sb-btn" onClick={requestUpdateCheck}>{tr('Błąd aktualizacji · ponów')}</button>
          <span className="sb-message" title={message}>{message}</span>
        </span>;
      }
      default:
        return <button className="sb-btn" onClick={requestUpdateCheck}>{tr('Sprawdź aktualizacje')}</button>;
    }
  })();

  return (
    <footer className="statusbar">
      {currentVersion && <span className="sb-version" title={tr('Wersja {version}', { version: currentVersion })}>ajzakomator v{currentVersion}</span>}
      {status}
    </footer>
  );
}
