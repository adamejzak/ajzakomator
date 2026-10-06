import type { StatusCounts } from '../../../shared/status';

/** ◐ working · ● waiting for you · ✕ exited */
export function StatusBadges({ counts, compact }: { counts: StatusCounts; compact?: boolean }) {
  const items: Array<[keyof StatusCounts, string, string]> = [
    ['working', '◐', 'pracuje'],
    ['waiting', '●', 'czeka na Ciebie'],
    ['exited', '✕', 'zakończony'],
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
