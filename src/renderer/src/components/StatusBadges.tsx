import { useI18n } from '../i18n';
import type { StatusCounts } from '../../../shared/status';

/** ◐ working · ● waiting for you · ✕ exited */
export function StatusBadges({ counts, compact }: { counts: StatusCounts; compact?: boolean }) {
  const { tr } = useI18n();
  const items: Array<[keyof StatusCounts, string, string]> = [
    ['working', '◐', tr("pracuje")],
    ['waiting', '●', tr("czeka na Ciebie")],
    ['exited', '✕', tr("zakończony")],
  ];
  const shown = items.filter(([k]) => counts[k] > 0);
  if (!shown.length) return null;
  return (
    <span className="badges">
      {shown.map(([k, icon, label]) => (
        <span key={k} className={`badge ${k}`} title={`${counts[k]} ${label}`}>
          {icon}
          {(!compact || counts[k] > 1) && <span>{counts[k]}</span>}
        </span>
      ))}
    </span>
  );
}
