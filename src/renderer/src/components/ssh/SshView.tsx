// The SSH view (W3, SSH mode in 0.9.2): one workspace tab with three sections chosen in the side panel (SshNav): Hosty (group
// tiles, host tiles by group, local shells), Klucze (key tiles) and Znane hosty (trusted host keys), with a details pane on the
// right for hosts and keys. Opened by the SSH rail tile, the palette, "Edytuj host" and "Wszystkie hosty…" (Add and cell menus).
// It stays mounted while its tab is open; the pane is "active" only while the view is on screen (D4: typed secrets go).
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { activeProject, activeTab, duplicateSshHost, updateSshHost } from '../../../../shared/state';
import { existingSelection, filterHosts, groupHosts, parseFoldedGroups, toggleSelection, userAtEndpoint, type SshHost } from '../../../../shared/ssh';
import {
  detailKey, groupTiles, hostsInGroup, hostTileState, liveDetail, liveGroupFilter, newKeyDetail, paneDetail, showGroupRow, toggleGroupFilter,
  type NewKeyMode, type SshDetail, type SshSection,
} from '../../../../shared/sshView';
import { describeLaunch, groupTerminalSources, listTerminalSources, type TerminalSource } from '../../../../shared/terminalSources';
import type { MessageKey } from '../../../../shared/i18n';
import { addAgent, quickTab } from '../../actions';
import { showTerminalTabs } from '../../files';
import { useI18n } from '../../i18n';
import { askText, getS, setUi, update, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { confirmRemoveSshHost, openHostInCell, openHostsAsGrid, showSshDetail } from '../../ssh';
import { openMenu, openMenuAt, type MenuItem } from '../ContextMenu';
import { IChevron, IKey, IPlus, IServer, ITerminalTab } from '../icons';
import { HostEditor } from './HostEditor';
import { KeyEditor } from './KeyEditor';
import { KnownHostsView } from './KnownHostsView';
import { NewKeyEditor } from './NewKeyEditor';
import { PaneActive } from './paneVisibility';
import { SshNav } from './SshNav';
import '../terminalPanel.css';
import './ssh.css';

const FOLD_KEY = 'mc-ssh-groups-v1';
const shortType = (type: string) => type.replace('ssh-', '').replace('ecdsa-sha2-nist', 'ecdsa-');
const STATE_LABEL = { connected: 'połączono', connecting: 'łączenie…', error: 'błąd połączenia', idle: 'rozłączono' } as const;
const PANE_HINT: Record<Exclude<SshSection, 'knownHosts'>, MessageKey> = { hosts: 'Wybierz host, aby zobaczyć szczegóły.', keys: 'Wybierz klucz, aby zobaczyć szczegóły.' };

/** "Nowy klucz > mode": always that mode, also when a new-key pane is already open (it is replaced by a fresh one). */
const newKey = (mode: NewKeyMode) => showSshDetail(newKeyDetail(useSshStore.getState().detail, mode));
const newKeyItems = (tr: (key: MessageKey) => string): MenuItem[] => [
  { label: tr('Wygeneruj klucz'), onClick: () => newKey('generate') },
  { label: tr('Importuj z pliku'), onClick: () => newKey('file') },
  { label: tr('Wklej klucz'), onClick: () => newKey('paste') },
];

export function SshView() {
  const { tr } = useI18n();
  const hosts = useStore((st) => st.s.sshHosts);
  const settingsActive = useStore((st) => st.ui.settingsActive);
  const collapsed = useStore((st) => st.s.sidebarCollapsed);
  const viewActive = useSshStore((st) => st.viewActive);
  const vault = useSshStore((st) => st.vault);
  const storedDetail = useSshStore((st) => st.detail);
  const section = useSshStore((st) => st.section);
  const keys = vault?.keys ?? [];
  const detail = paneDetail(section, liveDetail(storedDetail, hosts, keys.map((k) => k.id)));

  /** Connecting shows the grid: host key and password prompts appear in the cell. */
  const connect = (hostId: string, target: 'cell' | 'tab') => { showTerminalTabs(); void openHostInCell(hostId, target); };
  /** Esc clears the multi-selection; with nothing selected it is left to the rest of the app. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !useSshStore.getState().selectedHosts.length) return;
    e.preventDefault();
    e.stopPropagation();
    useSshStore.setState({ selectedHosts: [] });
  };

  return (
    <div className="ssh-view">
      <div className="ssh-view-main" onKeyDown={onKeyDown}>
        {/* With the side panel folded the view itself offers the sections. */}
        {collapsed && <SshNav compact />}
        {vault?.storage === 'unavailable' && <div className="ssh-banner-warn">{tr('Szyfrowanie systemowe jest niedostępne - klucze i hasła są trzymane tylko do zamknięcia aplikacji')}</div>}
        <div id="ssh-section" role="tabpanel" className="ssh-view-body" aria-label={tr(section === 'hosts' ? 'Hosty' : section === 'keys' ? 'Klucze' : 'Znane hosty')}>
          {section === 'hosts' && <HostsSection detail={detail} onConnect={connect} />}
          {section === 'keys' && <KeysSection detail={detail} />}
          {section === 'knownHosts' && <KnownHostsView />}
        </div>
      </div>
      {section !== 'knownHosts' && (
        <aside className="ssh-view-detail" aria-label={tr('Szczegóły')}>
          <PaneActive.Provider value={viewActive && !settingsActive}>
            {detail
              ? <DetailPane key={detailKey(detail)} detail={detail} onConnect={connect} />
              : <p className="ssh-card-hint ssh-view-empty">{tr(PANE_HINT[section])}</p>}
          </PaneActive.Provider>
        </aside>
      )}
    </div>
  );
}

/** An empty section: what it is for and the first step. */
function EmptyState({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children: ReactNode }) {
  return (
    <div className="ssh-empty">
      <span className="ssh-empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      <div className="ssh-empty-actions">{children}</div>
    </div>
  );
}

function HostsSection({ detail, onConnect }: { detail: SshDetail | null; onConnect: (hostId: string, target: 'cell' | 'tab') => void }) {
  const { tr } = useI18n();
  const hosts = useStore((st) => st.s.sshHosts);
  const projects = useStore((st) => st.s.projects);
  const profiles = useStore((st) => st.s.profiles);
  const shell = useStore((st) => st.s.settings.shell);
  const activeGrid = useStore((st) => activeTab(activeProject(st.s)));
  const sessions = useSshStore((st) => st.sessions);
  const selectedIds = useSshStore((st) => st.selectedHosts);
  const selected = useMemo(() => existingSelection(selectedIds, hosts), [selectedIds, hosts]);
  const cells = useMemo(() => projects.flatMap((p) => p.tabs.flatMap((t) => t.cells)), [projects]);
  const local = useMemo(() => groupTerminalSources(listTerminalSources({ profiles, platform: window.mc.platform, shell })).local, [profiles, shell]);
  const [query, setQuery] = useState('');
  const [chosenGroup, setGroup] = useState<string | null>(null);
  const [folded, setFolded] = useState<string[]>(() => parseFoldedGroups(localStorage.getItem(FOLD_KEY)));
  const searching = !!query.trim();
  const tiles = groupTiles(hosts);
  const group = liveGroupFilter(chosenGroup, hosts);
  const groups = groupHosts(filterHosts(hostsInGroup(hosts, group), query), !searching);
  const sshInGrid = activeGrid?.cells.filter((c) => c.ssh).length ?? 0;

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
  /** A different group filter clears the selection, so "Otwórz jako siatkę (n)" never counts hosts that are not shown. */
  const chooseGroup = (next: string | null) => {
    if (next === group) return;
    setGroup(next);
    useSshStore.setState({ selectedHosts: [] });
  };
  const openGrid = (ids: string[]) => { showTerminalTabs(); void openHostsAsGrid(ids); useSshStore.setState({ selectedHosts: [] }); };
  const groupMenu = (e: MouseEvent, name: string | null, ids: string[]) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: tr('Otwórz jako siatkę'), onClick: () => openGrid(ids) },
      ...(name ? [{ label: tr('Zmień nazwę grupy'), onClick: () => void renameGroup(name) }] : []),
    ]);
  };
  const clickTile = (e: MouseEvent, h: SshHost) => {
    if (e.ctrlKey || e.metaKey) { useSshStore.setState((st) => ({ selectedHosts: toggleSelection(st.selectedHosts, h.id) })); return; }
    useSshStore.setState({ selectedHosts: [] });
    showSshDetail({ kind: 'host', hostId: h.id });
  };
  const hostMenu = (e: MouseEvent, h: SshHost) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: tr('Połącz w aktywnej siatce'), onClick: () => onConnect(h.id, 'cell') },
      { label: tr('Otwórz w nowym gridzie'), onClick: () => onConnect(h.id, 'tab') },
      { sep: true },
      { label: tr('Edytuj'), onClick: () => showSshDetail({ kind: 'host', hostId: h.id }) },
      { label: tr('Duplikuj'), onClick: () => update((s) => duplicateSshHost(s, h.id)) },
      { label: tr('Kopiuj adres'), onClick: () => window.mc.clipboardWrite(userAtEndpoint(h)) },
      { sep: true },
      { label: tr('Usuń'), danger: true, onClick: () => void confirmRemoveSshHost(h.id) },
    ]);
  };
  const openLocal = (source: TerminalSource, target: 'cell' | 'tab') => {
    if (source.launch.type !== 'profile') return;
    showTerminalTabs();
    if (target === 'tab') quickTab(source.launch.profileId); else void addAgent(source.launch.profileId);
  };
  const broadcast = () => {
    const project = activeProject(getS());
    if (project && activeGrid) setUi({ modal: { kind: 'broadcast', projectId: project.id, tabId: activeGrid.id } });
  };

  return (
    <>
      <div className="ssh-view-titlebar"><h2 className="ssh-view-title">{tr('Hosty')}</h2></div>
      <div className="ssh-view-head">
        <input className="input ssh-search" placeholder={tr('Szukaj hostów...')} aria-label={tr('Szukaj hostów...')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="ssh-view-actions">
          <button className="btn primary" onClick={() => showSshDetail({ kind: 'host' })}><IPlus />{tr('Nowy host')}</button>
          <button className="btn" onClick={(e) => openMenuAt(e.currentTarget, newKeyItems(tr))}>{tr('Nowy klucz')} <IChevron /></button>
          <button className="btn ssh-broadcast-open" disabled={!sshInGrid} onClick={broadcast}>{tr('Wyślij do wszystkich ({count})', { count: sshInGrid })}</button>
        </div>
      </div>
      {selected.length > 0 && (
        <div className="ssh-view-selection">
          <span>{tr('Zaznaczono {count}', { count: selected.length })}</span>
          <button className="btn small primary ssh-open-grid" onClick={() => openGrid(selected)}>{tr('Otwórz jako siatkę ({count})', { count: selected.length })}</button>
          <button className="btn small ghost" onClick={() => useSshStore.setState({ selectedHosts: [] })}>{tr('Wyczyść zaznaczenie')}</button>
        </div>
      )}
      {!hosts.length ? (
        <EmptyState icon={<IServer />} title={tr('Nie masz jeszcze hostów')} text={tr('Zapisz adres, użytkownika i sposób logowania, a potem łącz się jednym kliknięciem w dowolnej siatce.')}>
          <button className="btn primary" onClick={() => showSshDetail({ kind: 'host' })}><IPlus />{tr('Nowy host')}</button>
        </EmptyState>
      ) : (
        <>
          {showGroupRow(tiles) && (
            <section className="ssh-view-section" aria-label={tr('Grupy')}>
              <h3 className="ssh-view-heading">{tr('Grupy')}</h3>
              <div className="ssh-group-tiles">
                <button className={`ssh-group-tile${group === null ? ' on' : ''}`} aria-pressed={group === null} aria-label={tr('{name}, hosty: {count}', { name: tr('Wszystkie'), count: hosts.length })} onClick={() => chooseGroup(null)}>
                  <span className="ssh-group-tile-name">{tr('Wszystkie')}</span>
                  <span className="ssh-group-tile-count" aria-hidden="true">{hosts.length}</span>
                </button>
                {tiles.map((t) => {
                  const name = t.name ?? tr('Bez grupy');
                  return (
                    <button key={t.key} className={`ssh-group-tile${group === t.key ? ' on' : ''}`} data-group={t.key} aria-pressed={group === t.key}
                      aria-label={tr('{name}, hosty: {count}', { name, count: t.count })}
                      title={tr('Pokaż tylko grupę {name}', { name })} onClick={() => chooseGroup(toggleGroupFilter(group, t.key))}
                      onContextMenu={(e) => groupMenu(e, t.name, hostsInGroup(hosts, t.key).map((h) => h.id))}>
                      <span className="ssh-group-tile-name">{name}</span>
                      <span className="ssh-group-tile-count" aria-hidden="true">{t.count}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          <section className="ssh-view-section" aria-label={tr('Hosty')}>
            {!groups.length ? <p className="terminal-empty">{tr('Nic nie znaleziono.')}</p> : groups.map((g) => {
              const key = g.name ?? '';
              const open = !folded.includes(key) || searching;
              const ids = g.hosts.map((h) => h.id);
              return (
                <div key={key} className="ssh-view-group">
                  <div className="ssh-group-bar">
                    <button className="ssh-group-head" aria-expanded={open} title={tr(open ? 'Zwiń grupę' : 'Rozwiń grupę')} onClick={() => toggleFold(key)} onContextMenu={(e) => groupMenu(e, g.name, ids)}>
                      <span className={open ? 'chev-down' : 'chev-right'}><IChevron /></span>
                      <span className="grow">{g.name ?? tr('Bez grupy')}</span>
                      <span className="muted">{g.hosts.length}</span>
                    </button>
                    <button className="btn small ghost ssh-group-open" onClick={() => openGrid(ids)}>{tr('Otwórz jako siatkę')}</button>
                  </div>
                  {open && (
                    <div className="ssh-tiles">
                      {g.hosts.map((h) => {
                        const state = hostTileState(h.id, cells, sessions);
                        const current = detail?.kind === 'host' && detail.hostId === h.id;
                        return (
                          <button key={h.id} className={`ssh-tile${selected.includes(h.id) ? ' selected' : ''}${current ? ' current' : ''}`} data-host-id={h.id}
                            aria-current={current ? 'true' : undefined} aria-pressed={selected.includes(h.id)}
                            onClick={(e) => clickTile(e, h)} onDoubleClick={() => onConnect(h.id, 'cell')} onContextMenu={(e) => hostMenu(e, h)}
                            title={`${userAtEndpoint(h)} · ${tr(STATE_LABEL[state])}`}>
                            <span className="ssh-tile-name"><span className="ssh-dot" style={{ background: h.color ?? 'var(--muted)' }} />{h.label}</span>
                            <span className="ssh-tile-detail">{userAtEndpoint(h)}</span>
                            <span className={`ssh-state ${state}`} aria-label={tr(STATE_LABEL[state])} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </>
      )}
      <section className="ssh-view-section ssh-local" aria-label={tr('Lokalne powłoki')}>
        <h3 className="ssh-view-heading">{tr('Lokalne powłoki')}</h3>
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
    </>
  );
}

function KeysSection({ detail }: { detail: SshDetail | null }) {
  const { tr } = useI18n();
  const vault = useSshStore((st) => st.vault);
  const keys = vault?.keys ?? [];
  return (
    <>
      <div className="ssh-view-titlebar">
        <h2 className="ssh-view-title">{tr('Klucze')}</h2>
        <div className="ssh-view-actions">
          <button className="btn primary ssh-new-key" onClick={(e) => openMenuAt(e.currentTarget, newKeyItems(tr))}><IPlus />{tr('Nowy klucz')} <IChevron /></button>
        </div>
      </div>
      {!keys.length ? (
        <EmptyState icon={<IKey />} title={tr('Nie masz jeszcze kluczy')} text={tr('Wygeneruj nowy klucz albo dodaj istniejący z pliku lub jako wklejony tekst. Klucz publiczny skopiujesz potem do authorized_keys na serwerze.')}>
          <button className="btn primary" onClick={() => newKey('generate')}>{tr('Wygeneruj klucz')}</button>
          <button className="btn" onClick={() => newKey('file')}>{tr('Importuj z pliku')}</button>
          <button className="btn" onClick={() => newKey('paste')}>{tr('Wklej klucz')}</button>
        </EmptyState>
      ) : (
        <section className="ssh-view-section" aria-label={tr('Klucze')}>
          <div className="ssh-tiles">
            {keys.map((k) => {
              const current = detail?.kind === 'key' && detail.keyId === k.id;
              return (
                <button key={k.id} className={`ssh-tile ssh-key-tile${current ? ' current' : ''}`} data-key-id={k.id} aria-current={current ? 'true' : undefined}
                  onClick={() => showSshDetail({ kind: 'key', keyId: k.id })} title={k.fingerprint}>
                  <span className="ssh-tile-name">{k.label}{k.locked ? ' !' : ''}</span>
                  <span className="ssh-tile-detail"><span className="ssh-key-type">{shortType(k.type)}</span>{k.fingerprint}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

function DetailPane({ detail, onConnect }: { detail: SshDetail; onConnect: (hostId: string, target: 'cell' | 'tab') => void }) {
  const { tr } = useI18n();
  if (detail.kind === 'host') {
    const hostId = detail.hostId;
    return (
      <>
        {hostId && (
          <div className="ssh-detail-actions">
            <button className="btn primary" onClick={() => onConnect(hostId, 'cell')}>{tr('Połącz')}</button>
            <button className="btn" onClick={() => onConnect(hostId, 'tab')}>{tr('Otwórz w nowym gridzie')}</button>
          </div>
        )}
        <HostEditor paneId={detailKey(detail)} hostId={hostId} />
      </>
    );
  }
  if (detail.kind === 'key') return <KeyEditor keyId={detail.keyId} />;
  return <NewKeyEditor initialMode={detail.mode} />;
}
