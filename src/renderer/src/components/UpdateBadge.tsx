import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../shared/types';
import './updater.css';

/** IPC failures from the brand menu are also surfaced in the badge. */
export function requestUpdateCheck(): void {
  void window.mc.checkUpdates().catch((error) => {
    window.dispatchEvent(new CustomEvent('update:renderer-error', { detail: String(error) }));
  });
}

export function formatUpdateBytes(bytes = 0): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}

export function UpdateBadge() {
  const { tr, errorText } = useI18n();
  const [u, setU] = useState<UpdateState>({ status: 'idle' });
  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    const unsubscribe = window.mc.on('update:state', (next) => { receivedEvent = true; if (mounted) setU(next); });
    const failed = (event: Event) => { receivedEvent = true; setU({ status: 'error', message: (event as CustomEvent<string>).detail }); };
    window.addEventListener('update:renderer-error', failed);
    void window.mc.getUpdate().then((next) => { if (mounted && !receivedEvent) setU(next); })
      .catch((error) => { if (mounted && !receivedEvent) setU({ status: 'error', message: String(error) }); });
    return () => { mounted = false; unsubscribe(); window.removeEventListener('update:renderer-error', failed); };
  }, []);
  const retry = requestUpdateCheck;
  if (u.status === 'idle') return null;
  if (u.status === 'downloading') {
    const percent = Math.round(Math.min(100, Math.max(0, Number.isFinite(u.percent) ? u.percent! : 0)));
    return <div className="updater-badge updater-download no-drag" role="status" title={tr('Pobieranie aktualizacji w tle')}>
      <div className="updater-download-row"><span>{tr('Pobieranie {version}… {percent}%', { version: u.version ?? '', percent })}</span>
        <span className="updater-transfer">{formatUpdateBytes(u.transferred)} / {formatUpdateBytes(u.total)} · {formatUpdateBytes(u.bytesPerSecond)}/s</span></div>
      <div className="updater-track" role="progressbar" aria-label={tr('Pobieranie aktualizacji w tle')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
    </div>;
  }
  if (u.status === 'checking' || u.status === 'installing') return <span className="updater-badge updater-busy no-drag" role="status"><span className="updater-spinner" aria-hidden />{tr(u.status === 'checking' ? 'Sprawdzanie aktualizacji…' : 'Instalowanie aktualizacji…')}</span>;
  if (u.status === 'current') return <button className="updater-badge updater-current no-drag" onClick={retry} title={tr('Sprawdź aktualizacje')}>✓ {tr('Masz najnowszą wersję')}</button>;
  if (u.status === 'error') return <div className="updater-badge updater-error no-drag" role="alert"><button onClick={retry}>{tr('Błąd aktualizacji · ponów')}</button><span className="updater-error-message" title={errorText(u.message ?? 'Nie udało się sprawdzić aktualizacji.')}>{errorText(u.message ?? 'Nie udało się sprawdzić aktualizacji.')}</span></div>;
  if (u.status === 'available') return <button className="updater-badge updater-action no-drag" onClick={() => window.mc.openReleases()} title={tr('Otwórz stronę pobierania')}><span className="updater-dot" />{tr('Nowa wersja {version} · pobierz', { version: u.version ?? '' })}</button>;
  return <button className="updater-badge updater-action no-drag" onClick={() => window.mc.installUpdate()} title={tr('Zainstaluj i uruchom ponownie (rozmowy wznowią się same)')}><span className="updater-dot" />{tr('Nowa wersja {version} · uruchom ponownie', { version: u.version ?? '' })}</button>;
}
