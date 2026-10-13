import { useState } from 'react';
import { CLI_NAMES, type CliId } from '../../../shared/cliStatus';
import { offerInstall, recheckCli, showCliInstructions, startCellAnyway } from '../actions';
import { useI18n } from '../i18n';
import { getUi, toast } from '../store';

/**
 * Shown instead of the terminal in a cell whose agent CLI is not installed. It degrades with the cell size
 * (container queries in styles.css): explanation first, then the secondary buttons, finally just the title.
 */
export function CliMissingCard({ cli, cellId, onChangeProfile }: { cli: CliId; cellId: string; onChangeProfile: (anchor: HTMLElement) => void }) {
  const { tr } = useI18n();
  const [checking, setChecking] = useState(false);
  const name = CLI_NAMES[cli];
  const title = tr('{name} nie jest zainstalowany', { name });

  const recheck = async () => {
    setChecking(true);
    await recheckCli(cli);
    setChecking(false);
    if (getUi().cliStatus[cli]?.state === 'missing') toast(tr('Nadal nie znaleziono: {name}', { name }));
  };

  return (
    <div className="cli-missing" role="group" aria-label={title} data-cli={cli} title={tr('Jeśli {name} działa w Twoim terminalu (np. jako alias albo z PATH z profilu powłoki), uruchom komórkę mimo to.', { name })}>
      <div className="cli-missing-inner">
        <div className="cli-missing-title" title={title}>{title}</div>
        <div className="cli-missing-text">{tr('Nie znaleziono polecenia „{command}”. Zainstaluj {name} albo użyj innego profilu.', { command: cli, name })}</div>
        <div className="cli-missing-actions">
          <button className="btn small primary cli-btn-install" onClick={() => offerInstall(cli)}>{tr('Zainstaluj')}</button>
          <button className="btn small cli-btn-docs" onClick={() => showCliInstructions(cli)}>{tr('Pokaż instrukcję')}</button>
          <button className="btn small cli-btn-profile" onClick={(e) => onChangeProfile(e.currentTarget)}>{tr('Zmień profil')}</button>
          <button className="btn small cli-btn-force" onClick={() => startCellAnyway(cellId)}>{tr('Uruchom mimo to')}</button>
          <button className="btn small cli-btn-check" disabled={checking} onClick={() => void recheck()}>{checking ? tr('Sprawdzam…') : tr('Sprawdź ponownie')}</button>
        </div>
      </div>
    </div>
  );
}
