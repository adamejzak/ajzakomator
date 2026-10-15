// The Git panel of a project that has no repository yet (or a machine without git): explains it and offers the way out.
import { useState } from 'react';
import { useI18n } from '../i18n';
import { askChoice, toast } from '../store';
import { refreshGitProbe } from '../git/gitProbe';
import { IBranch } from './icons';

export function GitSetup({ projectId, projectName, kind }: { projectId: string; projectName: string; kind: 'no-repo' | 'no-git' }) {
  const { tr, errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const windows = window.mc.platform === 'win32';

  const init = async () => {
    const choice = await askChoice(
      tr('Utworzyć repozytorium git?'),
      tr('W folderze projektu „{name}” powstanie repozytorium (polecenie git init, gałąź main). Pliki zostają bez zmian, a po utworzeniu możesz dodawać je do commitów.', { name: projectName }),
      [{ label: tr('Utwórz repozytorium'), value: 'init', primary: true }],
    );
    if (choice !== 'init') return;
    setBusy(true);
    try {
      const result = await window.mc.git.init(projectId);
      if (result.ok) toast(tr('Repozytorium git zostało utworzone.'));
      else toast(tr('Git: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) { toast(tr('Git: {error}', { error: String(e) }), 'error'); }
    finally { setBusy(false); void refreshGitProbe(projectId); }
  };

  const install = async () => {
    setBusy(true);
    try {
      const result = await window.mc.git.installGit();
      if (result.ok) toast(result.data.restart ? tr('Git został zainstalowany. Uruchom aplikację ponownie, aby go wykryć.') : tr('Otwarto stronę pobierania Gita.'));
      else toast(tr('Nie udało się zainstalować Gita automatycznie: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) { toast(String(e), 'error'); }
    finally { setBusy(false); void refreshGitProbe(projectId); }
  };

  return (
    <div className="sidebar-content git-panel">
      <div className="git-setup">
        <span className="git-setup-icon"><IBranch /></span>
        {kind === 'no-repo' ? <>
          <strong>{tr('Ten projekt nie ma jeszcze repozytorium git')}</strong>
          <p>{tr('Repozytorium pozwala śledzić zmiany, zatwierdzać je w commitach i cofać się do wcześniejszych wersji. Po jego utworzeniu pojawią się tu zmiany, historia i commit.')}</p>
          <button className="btn small primary" disabled={busy} onClick={() => void init()}>{busy ? '…' : tr('Utwórz repozytorium')}</button>
        </> : <>
          <strong>{tr('Git nie jest zainstalowany')}</strong>
          <p>{tr('Panel Git potrzebuje programu git na tym komputerze.')}{windows ? ` ${tr('Instalacja przez winget potrwa chwilę i może poprosić o zgodę.')}` : ''}</p>
          <div className="git-setup-actions">
            <button className="btn small primary" disabled={busy} onClick={() => void install()}>{busy ? '…' : windows || window.mc.platform === 'darwin' ? tr('Zainstaluj Git') : tr('Pobierz Git')}</button>
            <button className="btn small" onClick={() => window.mc.openExternal('https://git-scm.com/downloads')}>git-scm.com</button>
            <button className="btn small" disabled={busy} onClick={() => void refreshGitProbe(projectId)}>{tr('Sprawdź ponownie')}</button>
          </div>
        </>}
      </div>
    </div>
  );
}
