// Start options of one agent profile: typical switches with a plain-language explanation, the raw arguments and a preview of the command.
import type { Profile } from '../../../shared/types';
import { AGENT_PRESETS, commandPreview, hasFlag, toggleFlag } from '../../../shared/agentPresets';
import { useI18n } from '../i18n';

export function ProfileOptions({ profile, onChange }: { profile: Profile; onChange(args: string): void }) {
  const { tr } = useI18n();
  if (profile.cli === 'shell') return <p className="profile-note">{tr('Profil powłoki uruchamia zwykły terminal, bez opcji agenta.')}</p>;
  const presets = AGENT_PRESETS[profile.cli];
  const command = commandPreview(profile.cli, profile.args);
  return (
    <div className="profile-options">
      <div className="profile-options-title">{tr('Opcje startowe')}</div>
      <div className="profile-preset-list">
        {presets.map((preset) => (
          <label key={preset.flag} className={`profile-preset ${preset.risky ? 'risky' : ''}`}>
            <span className="profile-preset-copy">
              <code>{preset.flag}</code>
              {preset.risky && <span className="profile-risk">{tr('Ostrożnie')}</span>}
              <span className="profile-preset-hint">{tr(preset.hint)}</span>
            </span>
            <input className="setting-switch" type="checkbox" role="switch" aria-label={preset.flag} checked={hasFlag(profile.args, preset.flag)}
              onChange={(e) => onChange(toggleFlag(profile.args, profile.cli, preset.flag, e.target.checked))} />
          </label>
        ))}
      </div>
      <label className="profile-args-field">
        <span className="profile-options-title">{tr('Własne argumenty')}</span>
        <span className="profile-preset-hint">{tr('Dopisywane do polecenia przy każdym starcie komórki z tym profilem, np. --model opus.')}</span>
        <input id={`settings-profile-args-${profile.id}`} className="input profile-args" aria-label={tr('argumenty CLI')} placeholder={tr('argumenty CLI')} value={profile.args}
          spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      </label>
      <div className="profile-command" title={tr('Tym poleceniem startuje komórka z tym profilem')}><span>{tr('Polecenie')}</span><code>{command}</code></div>
    </div>
  );
}
