import { BACKGROUND_MAX_CELLS } from '../../../shared/backgroundLoad';
import { useI18n } from '../i18n';
import { useStore } from '../store';

/** "Loading sessions in the background: 3/9" in the status bar, only while the background loader has work. */
export function BackgroundLoadHint() {
  const { tr } = useI18n();
  const progress = useStore((st) => st.ui.backgroundLoad);
  if (!progress) return null;
  const title = progress.capped
    ? tr('Limit automatycznych startów w tle: {max}. Pozostałe sesje startują po otwarciu ich zakładki.', { max: BACKGROUND_MAX_CELLS })
    : tr('Terminale w pozostałych zakładkach uruchamiają się po kolei, żeby aplikacja nie zwalniała.');
  return <span className="sb-item sb-muted" role="status" title={title}>
    {progress.capped
      ? tr('Wczytano {done} z {total} sesji w tle (limit)', { done: progress.done, total: progress.total })
      : tr('Wczytuję sesje w tle: {done}/{total}', { done: Math.min(progress.done, progress.total), total: progress.total })}
  </span>;
}
