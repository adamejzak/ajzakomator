import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../shared/types';

/** Top-right pill: download progress, then "restart to update" (or a download link for portable). */
export function UpdateBadge() {
  const [u, setU] = useState<UpdateState>({ status: 'idle' });
  useEffect(() => {
    void window.mc.getUpdate().then(setU);
    return window.mc.on('update:state', setU);
  }, []);
  if (u.status === 'idle') return null;
  if (u.status === 'downloading')
    return <span className="update-pill muted-pill" title="Pobieranie aktualizacji w tle">Pobieranie {u.version}… {u.percent ?? 0}%</span>;
  if (u.status === 'available')
    return (
      <button className="update-pill" onClick={() => window.mc.openReleases()} title="Otwórz stronę pobierania">
        <span className="pulse" /> Nowa wersja {u.version} · pobierz
      </button>
    );
  return (
    <button className="update-pill" onClick={() => window.mc.installUpdate()} title="Zainstaluj i uruchom ponownie (rozmowy wznowią się same)">
      <span className="pulse" /> Nowa wersja {u.version} · uruchom ponownie
    </button>
  );
}
