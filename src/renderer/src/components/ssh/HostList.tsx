// Saved hosts grouped and searchable (spec 10.1). Click connects in the active grid; Ctrl/Cmd+click selects several.
import { useState, type MouseEvent } from 'react';
import { filterHosts, groupHosts, parseFoldedGroups, toggleSelection, userAtEndpoint, type SshHost } from '../../../../shared/ssh';
import { duplicateSshHost, updateSshHost } from '../../../../shared/state';
import { useI18n } from '../../i18n';
import { askText, update, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { confirmRemoveSshHost, openHostInCell, openHostsAsGrid, openSshEditor } from '../../ssh';
import { openMenu } from '../ContextMenu';
import { IChevron, IEdit, ITerminalTab } from '../icons';

const FOLD_KEY = 'mc-ssh-groups-v1';

export function HostList({ query }: { query: string }) {
  const { tr } = useI18n();
  const hosts = useStore((st) => st.s.sshHosts);
  const selected = useSshStore((st) => st.selectedHosts);
  const [folded, setFolded] = useState<string[]>(() => parseFoldedGroups(localStorage.getItem(FOLD_KEY)));
  const searching = !!query.trim();
  const groups = groupHosts(filterHosts(hosts, query), !searching);
  const toggleFold = (key: string) => {
    const next = folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key];
    setFolded(next);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* the folding of this session stays */ }
  };
  const renameGroup = async (name: string) => {
    const next = (await askText(tr('Zmień nazwę grupy'), name))?.trim();
    if (next === undefined || next === name) return;
    update((s) => s.sshHosts.filter((h) => h.group === name).reduce((acc, h) => updateSshHost(acc, h.id, { group: next || undefined }), s));
  };
  const hostMenu = (e: MouseEvent, h: SshHost) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: tr('Połącz w aktywnej siatce'), onClick: () => void openHostInCell(h.id, 'cell') },
      { label: tr('Połącz w nowej zakładce'), onClick: () => void openHostInCell(h.id, 'tab') },
      { sep: true },
      { label: tr('Edytuj'), onClick: () => openSshEditor('host', h.id) },
      { label: tr('Duplikuj'), onClick: () => update((s) => duplicateSshHost(s, h.id)) },
      { label: tr('Kopiuj adres'), onClick: () => window.mc.clipboardWrite(userAtEndpoint(h)) },
      { sep: true },
      { label: tr('Usuń'), danger: true, onClick: () => void confirmRemoveSshHost(h.id) },
    ]);
  };
  const click = (e: MouseEvent, h: SshHost) => {
    if (e.ctrlKey || e.metaKey) { useSshStore.setState((st) => ({ selectedHosts: toggleSelection(st.selectedHosts, h.id) })); return; }
    useSshStore.setState({ selectedHosts: [] });
    void openHostInCell(h.id, 'cell');
  };

  if (!hosts.length) return <p className="terminal-empty">{tr('Brak hostów. Dodaj pierwszy host.')}</p>;
  if (!groups.length) return <p className="terminal-empty">{tr('Nic nie znaleziono.')}</p>;
  return (
    <div className="ssh-hosts">
      {groups.map((g) => {
        const key = g.name ?? '';
        const open = !folded.includes(key) || searching;
        return (
          <div key={key} className="ssh-group">
            <button className="ssh-group-head" aria-expanded={open} title={tr(open ? 'Zwiń grupę' : 'Rozwiń grupę')} onClick={() => toggleFold(key)}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, [
                  { label: tr('Otwórz jako siatkę'), onClick: () => void openHostsAsGrid(g.hosts.map((h) => h.id)) },
                  ...(g.name ? [{ label: tr('Zmień nazwę grupy'), onClick: () => void renameGroup(g.name!) }] : []),
                ]);
              }}>
              <span className={open ? 'chev-down' : 'chev-right'}><IChevron /></span>
              <span className="grow">{g.name ?? tr('Bez grupy')}</span>
              <span className="muted">{g.hosts.length}</span>
            </button>
            {open && g.hosts.map((h) => (
              <div key={h.id} className={`terminal-source ssh-host-row${selected.includes(h.id) ? ' selected' : ''}`} onContextMenu={(e) => hostMenu(e, h)}>
                <button className="terminal-source-main" onClick={(e) => click(e, h)} title={`${tr('Połącz w aktywnej siatce')} - ${userAtEndpoint(h)}`}>
                  <span className="terminal-source-name"><span className="ssh-dot" style={{ background: h.color ?? 'var(--muted)' }} />{h.label}</span>
                  <span className="terminal-source-detail">{userAtEndpoint(h)}</span>
                </button>
                <button className="btn ghost icon small" aria-label={tr('Połącz w nowej zakładce')} title={tr('Połącz w nowej zakładce')} onClick={() => void openHostInCell(h.id, 'tab')}><ITerminalTab /></button>
                <button className="btn ghost icon small" aria-label={tr('Edytuj')} title={tr('Edytuj')} onClick={() => openSshEditor('host', h.id)}><IEdit /></button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
