import { useMemo } from 'react';
import { useI18n } from '../i18n';
import { canLaunchSource, describeLaunch, groupTerminalSources, listTerminalSources, type TerminalSource } from '../../../shared/terminalSources';
import { addAgent, quickTab } from '../actions';
import { toast, useStore } from '../store';
import { IPlus, ITerminalTab } from './icons';
import { openMenu } from './ContextMenu';
import './terminalPanel.css';

/**
 * The Terminal panel: new terminals from the sources of shared/terminalSources.ts. The local shells are listed now; the
 * "Połączenia" section is where SSH hosts will appear once a provider for them exists.
 */
export function TerminalPanel() {
  const { tr } = useI18n();
  const profiles = useStore((st) => st.s.profiles);
  const shell = useStore((st) => st.s.settings.shell);
  const sources = useMemo(() => listTerminalSources({ profiles, platform: window.mc.platform, shell }), [profiles, shell]);
  const { local, connections } = groupTerminalSources(sources);

  const open = (source: TerminalSource, target: 'cell' | 'tab'): void => {
    if (!canLaunchSource(source) || source.launch.type !== 'profile') { toast(tr('To połączenie nie jest jeszcze obsługiwane.'), 'error'); return; }
    if (target === 'tab') quickTab(source.launch.profileId);
    else void addAgent(source.launch.profileId);
  };
  const main = local[0];

  return (
    <div className="sidebar-content terminal-panel">
      <div className="terminal-actions">
        <button className="btn primary" disabled={!main} onClick={() => main && open(main, 'cell')} title={tr('Nowy terminal w aktywnej siatce')}>
          <IPlus />{tr('Nowy terminal')}
        </button>
        <button className="btn" disabled={!main} onClick={() => main && open(main, 'tab')} title={tr('Nowy terminal (zakładka)')}>
          <ITerminalTab />{tr('Nowy terminal (zakładka)')}
        </button>
      </div>
      <div className="terminal-sections">
        <section aria-label={tr('Lokalne powłoki')}>
          <h4 className="terminal-heading">{tr('Lokalne powłoki')}</h4>
          {local.map((source) => (
            <div
              key={source.id}
              className="terminal-source"
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, [
                  { label: tr('Nowy terminal w aktywnej siatce'), onClick: () => open(source, 'cell') },
                  { label: tr('Nowy terminal (zakładka)'), onClick: () => open(source, 'tab') },
                ]);
              }}
            >
              <button className="terminal-source-main" onClick={() => open(source, 'cell')} title={`${tr('Nowy terminal w aktywnej siatce')} - ${describeLaunch(source.launch)}`}>
                <span className="terminal-source-name">{source.label}</span>
                {source.detail && <span className="terminal-source-detail">{source.detail}</span>}
              </button>
              <button className="btn ghost icon small" aria-label={tr('Nowy terminal (zakładka)')} title={tr('Nowy terminal (zakładka)')} onClick={() => open(source, 'tab')}><ITerminalTab /></button>
            </div>
          ))}
        </section>
        <section aria-label={tr('Połączenia')}>
          <h4 className="terminal-heading">{tr('Połączenia')}</h4>
          {connections.map((source) => (
            <div key={source.id} className="terminal-source">
              <button className="terminal-source-main" onClick={() => open(source, 'cell')} title={describeLaunch(source.launch)}>
                <span className="terminal-source-name">{source.label}</span>
                {source.detail && <span className="terminal-source-detail">{source.detail}</span>}
              </button>
            </div>
          ))}
          {!connections.length && <p className="terminal-empty">{tr('Połączenia SSH pojawią się tutaj')}</p>}
        </section>
      </div>
    </div>
  );
}
