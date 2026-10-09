import type { AgentRole } from '../../../shared/automation';
import { useI18n } from '../i18n';
import { openMenuAt } from './ContextMenu';
import { IChevron } from './icons';
export function RoleSelect({ value, disabled, onChange }: { value?: AgentRole; disabled?: boolean; onChange: (role?: AgentRole) => void }) {
  const { tr } = useI18n();
  return <button type="button" className={`select role-select ${value ?? ''}`} aria-label={tr('Rola agenta')} aria-haspopup="menu" data-role={value ?? ''} disabled={disabled}
    onClick={(e) => openMenuAt(e.currentTarget, [
      { header: tr('Rola / MCP') },
      { label: tr('Bez MCP'), hint: !value ? '✓' : undefined, onClick: () => onChange(undefined) },
      { label: tr('Koordynator'), hint: value === 'coordinator' ? '✓' : undefined, onClick: () => onChange('coordinator') },
      { label: tr('Wykonawca'), hint: value === 'worker' ? '✓' : undefined, onClick: () => onChange('worker') },
    ])}>{tr(value === 'coordinator' ? 'Koordynator' : value === 'worker' ? 'Wykonawca' : 'Bez MCP')}<IChevron /></button>;
}
