import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../shared/types';

/** Top-right pill: download progress, then "restart to update" (or a download link for portable). */
export function UpdateBadge() {
  const { tr } = useI18n();
  const [u, setU] = useState<UpdateState>({ status: 'idle' });
  useEffect(() => {
    void window.mc.getUpdate().then(setU);
    return window.mc.on('update:state', setU);
  }, []);
  if (u.status === 'idle') return null;
  if (u.status === 'downloading')
    return <span className="update-pill muted-pill" title={tr("Pobieranie aktualizacji w tle")}>{tr('Pobieranie {version}… {percent}%', { version: u.version ?? '', percent: u.percent ?? 0 })}</span>;
  if (u.status === 'available')
    return (
      <button className="update-pill" onClick={() => window.mc.openReleases()} title={tr("Otwórz stronę pobierania")}>
        <span className="pulse" /> {tr('Nowa wersja {version} · pobierz', { version: u.version ?? '' })}
      </button>
    );
  return (
    <button className="update-pill" onClick={() => window.mc.installUpdate()} title={tr("Zainstaluj i uruchom ponownie (rozmowy wznowią się same)")}>
      <span className="pulse" /> {tr('Nowa wersja {version} · uruchom ponownie', { version: u.version ?? '' })}
    </button>
  );
}
