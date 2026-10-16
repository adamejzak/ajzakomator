// The SSH panel (rail tile "SSH", spec 10.1): actions, host search, hosts by group, keys, and the local shells as before.
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { describeLaunch, groupTerminalSources, listTerminalSources, type TerminalSource } from '../../../shared/terminalSources';
import { addAgent, quickTab } from '../actions';
import { useStore } from '../store';
import { useSshStore } from '../sshStore';
import { openHostsAsGrid, openSshEditor } from '../ssh';
import { IChevron, IPlus, ITerminalTab } from './icons';
import { openMenu, openMenuAt } from './ContextMenu';
import { HostList } from './ssh/HostList';
import { KeyList } from './ssh/KeyList';
import './terminalPanel.css';
import './ssh/ssh.css';

export function TerminalPanel() {
  const { tr } = useI18n();
  const profiles = useStore((st) => st.s.profiles);
  const shell = useStore((st) => st.s.settings.shell);
  const storage = useSshStore((st) => st.vault?.storage);
  const selected = useSshStore((st) => st.selectedHosts);
  const [query, setQuery] = useState('');
  const local = useMemo(() => groupTerminalSources(listTerminalSources({ profiles, platform: window.mc.platform, shell })).local, [profiles, shell]);
  const openLocal = (source: TerminalSource, target: 'cell' | 'tab') => {
    if (source.launch.type !== 'profile') return;
    if (target === 'tab') quickTab(source.launch.profileId); else void addAgent(source.launch.profileId);
  };
  return (
    <div className="sidebar-content terminal-panel">
      <div className="terminal-actions">
        <button className="btn primary" onClick={() => openSshEditor('host')}><IPlus />{tr('Nowy host')}</button>
        <button className="btn" onClick={(e) => openMenuAt(e.currentTarget, [
          { label: tr('Wygeneruj klucz'), onClick: () => openSshEditor('newKey', 'generate') },
          { label: tr('Importuj z pliku'), onClick: () => openSshEditor('newKey', 'file') },
          { label: tr('Wklej klucz'), onClick: () => openSshEditor('newKey', 'paste') },
        ])}>{tr('Klucz')} <IChevron /></button>
      </div>
      {storage === 'unavailable' && <div className="ssh-banner-warn">{tr('Szyfrowanie systemowe jest niedostępne - klucze i hasła są trzymane tylko do zamknięcia aplikacji')}</div>}
      <input className="input ssh-search" placeholder={tr('Szukaj hostów...')} aria-label={tr('Szukaj hostów...')} value={query} onChange={(e) => setQuery(e.target.value)} />
      {selected.length > 0 && (
        <button className="btn small ssh-open-grid" onClick={() => { void openHostsAsGrid(selected); useSshStore.setState({ selectedHosts: [] }); }}>{tr('Otwórz jako siatkę ({count})', { count: selected.length })}</button>
      )}
      <div className="terminal-sections">
        <section aria-label={tr('Hosty')}>
          <h4 className="terminal-heading">{tr('Hosty')}</h4>
          <HostList query={query} />
        </section>
        <section aria-label={tr('Klucze')}>
          <h4 className="terminal-heading">{tr('Klucze')}</h4>
          <KeyList />
        </section>
        <section aria-label={tr('Lokalne powłoki')}>
          <h4 className="terminal-heading">{tr('Lokalne powłoki')}</h4>
          {local.map((source) => (
            <div key={source.id} className="terminal-source" onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, [
                { label: tr('Nowy terminal w aktywnej siatce'), onClick: () => openLocal(source, 'cell') },
                { label: tr('Nowy terminal (zakładka)'), onClick: () => openLocal(source, 'tab') },
              ]);
            }}>
              <button className="terminal-source-main" onClick={() => openLocal(source, 'cell')} title={`${tr('Nowy terminal w aktywnej siatce')} - ${describeLaunch(source.launch)}`}>
                <span className="terminal-source-name">{source.label}</span>
                {source.detail && <span className="terminal-source-detail">{source.detail}</span>}
              </button>
              <button className="btn ghost icon small" aria-label={tr('Nowy terminal (zakładka)')} title={tr('Nowy terminal (zakładka)')} onClick={() => openLocal(source, 'tab')}><ITerminalTab /></button>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
