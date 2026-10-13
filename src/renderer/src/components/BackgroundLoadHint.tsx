import { useI18n } from '../i18n';
import { useStore } from '../store';

/** "Loading sessions in the background: 3/9" in the status bar, only while the background loader has work. */
export function BackgroundLoadHint() {
  const { tr } = useI18n();
  const progress = useStore((st) => st.ui.backgroundLoad);
  if (!progress) return null;
  return <span className="sb-item sb-muted" role="status" title={tr('Terminale w pozostałych zakładkach uruchamiają się po kolei, żeby aplikacja nie zwalniała.')}>
    {tr('Wczytuję sesje w tle: {done}/{total}', { done: Math.min(progress.done, progress.total), total: progress.total })}
  </span>;
}
