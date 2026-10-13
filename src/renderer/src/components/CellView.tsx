import { changeAgentRole } from '../agentRoles';
import { keyLabel } from '../platform';
import { useI18n } from '../i18n';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getProfile, PROJECT_COLORS } from '../../../shared/state';
import { missingCardCli } from '../../../shared/cliStatus';
import { profileOptionLabel } from '../cliUi';
import { CliMissingCard } from './CliMissingCard';
import type { Cell } from '../../../shared/types';
import {
  changeCellProfile, ensureStarted, ensureTerminal, removeCell, renameCell, restartCell, sendSnippet, setCellColor, toggleMaximize,
} from '../actions';
import { setUi, toast, useStore } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { openMenu, openMenuAt, type MenuItem } from './ContextMenu';
import { IBranch, IMax, IRestart, IRestore, IX } from './icons';

export const SNIPPET_MIME = 'application/x-mc-snippet';



export function CellView({ cell, index, style, maximized, dragSource, onHeadPointerDown }: {
  cell: Cell; index: number; style: CSSProperties; maximized: boolean;
  /** This cell is being dragged to another slot. */
  dragSource?: boolean;
  /** Present when the header may start a drag (more than one cell, not maximized). */
  onHeadPointerDown?: (e: React.PointerEvent<HTMLElement>, cell: Cell) => void;
}) {
  const { tr, errorText } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const profiles = useStore((st) => st.s.profiles);
  const profile = useStore((st) => getProfile(st.s, cell.profileId));
  const status = useStore((st) => st.ui.statuses[cell.id] ?? 'idle');
  const focused = useStore((st) => st.ui.focusedCellId === cell.id);
  const mcpInfo = useStore((st) => st.ui.mcpInfo);
  const error = useStore((st) => st.ui.cellErrors[cell.id]);
  const epoch = useStore((st) => st.ui.epoch);
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const held = useStore((st) => st.ui.heldCells[cell.id] === true);
  // The card replaces the terminal only while the cell is held; a running terminal is never hidden by a late "missing".
  const lackingCli = missingCardCli(profile, cliStatus, held);
  const sessionTitle = useStore((st) => (cell.session ? st.ui.sessionTitles[cell.session.id] : undefined));
  const [drop, setDrop] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const el = bodyRef.current!;
    // Attach (and fit) before starting so the pty is spawned with the cell's real size.
    ensureTerminal(cell.id);
    terminals.attach(cell.id, el);
    ensureStarted(cell.id);
    return () => terminals.detach(cell.id, el);
  }, [cell.id, epoch]);

  const markFocused = () => {
    setUi({ focusedCellId: cell.id });
  };

  const label = cell.name ?? sessionTitle;

  const profileItems = (): MenuItem[] => [
    { header: tr("Zmień profil (nowa rozmowa)") },
    ...profiles.map((p) => ({ label: profileOptionLabel(p, cliStatus, tr), onClick: () => changeCellProfile(cell.id, p.id) })),
  ];

  const restartItems = (): MenuItem[] => [
    ...(cell.session ? [{ label: tr("Uruchom ponownie i wznów rozmowę"), onClick: () => restartCell(cell.id, 'resume') }] : []),
    { label: profile.cli === 'shell' ? tr("Uruchom ponownie") : tr("Nowa rozmowa"), onClick: () => restartCell(cell.id, 'new') },
  ];

  const headerMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: tr("Zmień nazwę"), onClick: () => setEditing(true) },
      ...(cell.name ? [{ label: tr("Przywróć nazwę automatyczną"), onClick: () => renameCell(cell.id, '') }] : []),
      { header: tr("Kolor") },
      { colors: PROJECT_COLORS, onPick: (c: string) => setCellColor(cell.id, c) },
      ...(cell.color ? [{ label: tr("Usuń kolor"), onClick: () => setCellColor(cell.id, undefined) }] : []),
      { sep: true },
      ...restartItems(),
      { label: maximized ? tr("Przywróć siatkę") : tr("Maksymalizuj"), onClick: () => toggleMaximize(cell.id), hint: keyLabel("Ctrl+Shift+M") },
      { sep: true },
      ...profileItems(),
      ...(profile.cli !== 'shell' ? [
        { sep: true as const },
        { label: tr('Bez MCP'), onClick: () => { void changeAgentRole(cell.id, null); } },
        { label: tr('Koordynator'), onClick: () => { void changeAgentRole(cell.id, 'coordinator'); } },
        { label: tr('Wykonawca'), onClick: () => { void changeAgentRole(cell.id, 'worker'); } },
      ] : []),
      { sep: true },
      { label: tr("Zamknij komórkę"), danger: true, onClick: () => void removeCell(cell.id) },
    ]);
  };

  return (
    <div
      data-cell-id={cell.id}
      className={`cell ${focused ? 'focused' : ''} ${drop ? 'drop' : ''} ${cell.color ? 'colored' : ''} ${dragSource ? 'drag-source' : ''}`}
      style={cell.color ? { ...style, ['--cc' as string]: cell.color } : style}
      onMouseDownCapture={markFocused}
      onFocusCapture={markFocused}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SNIPPET_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false);
        const raw = e.dataTransfer.getData(SNIPPET_MIME);
        if (!raw) return;
        e.preventDefault();
        sendSnippet(JSON.parse(raw), { cellId: cell.id });
      }}
    >
      <div
        className={`cell-head ${onHeadPointerDown ? 'draggable' : ''}`}
        title={onHeadPointerDown ? tr('Przeciągnij za pasek, aby zamienić komórki miejscami') : undefined}
        onPointerDown={onHeadPointerDown && ((e) => onHeadPointerDown(e, cell))}
        onContextMenu={headerMenu}
        onDoubleClick={(e) => (e.target as HTMLElement).closest('button,.cell-name,input') || toggleMaximize(cell.id)}
      >
        <span className="idx">{index + 1}</span>
        <span className={`dot ${status}`} />
        <span className="profile" onClick={(e) => openMenuAt(e.currentTarget, profileItems())} title={tr("Zmień profil")}>
          <span className="pchip" style={{ background: profile.color }} />
          {profile.name}
        </span>
        {editing ? (
          <input
            className="cell-name-input"
            autoFocus
            defaultValue={cell.name ?? sessionTitle ?? ''}
            placeholder={tr("Nazwa komórki")}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              renameCell(cell.id, e.target.value);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditing(false);
              e.stopPropagation();
            }}
          />
        ) : (
          label && (
            <span className={`cell-name ${cell.name ? 'custom' : ''}`} title={`${label}\n${tr('Dwuklik: zmień nazwę')}`} onDoubleClick={() => setEditing(true)}>
              {label}
            </span>
          )
        )}
        {!label && !editing && (
          <span className="cell-name placeholder" onDoubleClick={() => setEditing(true)} title={tr("Dwuklik: nadaj nazwę")}>{tr("bez nazwy")}</span>
        )}
        {cell.worktree && (
          <span className="branch" title={cell.worktree.path}><IBranch /> {cell.worktree.branch}</span>
        )}
        {status !== 'idle' && <span className={`status-text ${status}`}>{status === 'working' ? tr('pracuje') : status === 'waiting' ? tr('czeka na Ciebie') : tr('zakończony')}{status === 'working' ? '…' : ''}</span>}
        <span className="grow" />
        {profile.cli !== 'shell' && <button className={`mcp-control ${cell.role ?? 'disabled'} ${mcpInfo.connectedCellIds?.includes(cell.id) ? 'connected' : ''}`}
          aria-label={`${tr('Rola / MCP')}: ${tr(cell.role === 'coordinator' ? 'Koordynator' : cell.role === 'worker' ? 'Wykonawca' : 'Bez MCP')}`}
          title={`${tr(cell.role === 'coordinator' ? 'Koordynator' : cell.role === 'worker' ? 'Wykonawca' : 'Bez MCP')} · ${tr(cell.role ? mcpInfo.connectedCellIds?.includes(cell.id) ? 'MCP działa' : mcpInfo.configuredCellIds?.includes(cell.id) ? 'MCP skonfigurowane · oczekiwanie na agenta' : 'Wymaga restartu' : 'Rola / MCP')}`}
          onClick={(e) => openMenuAt(e.currentTarget, [
            { header: tr('Rola / MCP') },
            { label: tr('Koordynator'), hint: cell.role === 'coordinator' ? '✓' : undefined, onClick: () => void changeAgentRole(cell.id, 'coordinator') },
            { label: tr('Wykonawca'), hint: cell.role === 'worker' ? '✓' : undefined, onClick: () => void changeAgentRole(cell.id, 'worker') },
            { label: tr('Bez MCP'), hint: !cell.role ? '✓' : undefined, onClick: () => void changeAgentRole(cell.id, null) },
          ])}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {cell.role === 'coordinator' ? <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v6M5 17v-4h14v4" /></> : <><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />{!cell.role && <path d="m3 3 18 18" />}</>}
          </svg><span className="mcp-indicator" />
        </button>}
        <span className="actions">
          <button title={tr("Uruchom ponownie")} onClick={(e) => openMenuAt(e.currentTarget, restartItems())}><IRestart /></button>
          <button title={maximized ? tr("Przywróć siatkę") + keyLabel(" (Ctrl+Shift+M)") : tr("Maksymalizuj") + keyLabel(" (Ctrl+Shift+M)")} onClick={() => toggleMaximize(cell.id)}>
            {maximized ? <IRestore /> : <IMax />}
          </button>
          <button title={tr("Zamknij komórkę")} onClick={() => void removeCell(cell.id)}><IX /></button>
        </span>
      </div>
      <div className="cell-body" ref={bodyRef} style={lackingCli ? { visibility: 'hidden' } : undefined} />
      {lackingCli && <CliMissingCard cli={lackingCli} cellId={cell.id} onChangeProfile={(anchor) => openMenuAt(anchor, profileItems())} />}
      {error && (
        <div className="cell-error">
          <span className="grow">{errorText(error)}</span>
          <button className="btn small" onClick={() => restartCell(cell.id, cell.session ? 'resume' : 'new')}>{tr("Spróbuj ponownie")}</button>
        </div>
      )}
    </div>
  );
}
