import { keyLabel } from '../platform';
import { useI18n } from '../i18n';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getProfile, PROJECT_COLORS } from '../../../shared/state';
import type { Cell } from '../../../shared/types';
import {
  changeCellProfile, ensureStarted, ensureTerminal, removeCell, renameCell, restartCell, sendSnippet, setCellColor, toggleMaximize,
} from '../actions';
import { setUi, useStore } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { openMenu, openMenuAt, type MenuItem } from './ContextMenu';
import { IBranch, IMax, IRestart, IRestore, IX } from './icons';

export const SNIPPET_MIME = 'application/x-mc-snippet';



export function CellView({ cell, index, style, maximized }: { cell: Cell; index: number; style: CSSProperties; maximized: boolean }) {
  const { tr, errorText } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const profiles = useStore((st) => st.s.profiles);
  const profile = useStore((st) => getProfile(st.s, cell.profileId));
  const status = useStore((st) => st.ui.statuses[cell.id] ?? 'idle');
  const focused = useStore((st) => st.ui.focusedCellId === cell.id);
  const error = useStore((st) => st.ui.cellErrors[cell.id]);
  const epoch = useStore((st) => st.ui.epoch);
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
    terminals.acknowledge(cell.id);
  };

  const label = cell.name ?? sessionTitle;

  const profileItems = (): MenuItem[] => [
    { header: tr("Zmień profil (nowa rozmowa)") },
    ...profiles.map((p) => ({ label: p.name, onClick: () => changeCellProfile(cell.id, p.id) })),
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
      { sep: true },
      { label: tr("Zamknij komórkę"), danger: true, onClick: () => void removeCell(cell.id) },
    ]);
  };

  return (
    <div
      className={`cell ${focused ? 'focused' : ''} ${drop ? 'drop' : ''} ${cell.color ? 'colored' : ''}`}
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
        className="cell-head"
        onContextMenu={headerMenu}
        onDoubleClick={(e) => (e.target as HTMLElement).closest('button,.cell-name,input') || toggleMaximize(cell.id)}
      >
        <span className="idx">{index + 1}</span>
        <span className={`dot ${status}`} />
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
        <span className="profile" onClick={(e) => openMenuAt(e.currentTarget, profileItems())} title={tr("Zmień profil")}>
          <span className="pchip" style={{ background: profile.color }} />
          {profile.name}
        </span>
        {!label && !editing && (
          <span className="cell-name placeholder" onDoubleClick={() => setEditing(true)} title={tr("Dwuklik: nadaj nazwę")}>{tr("bez nazwy")}</span>
        )}
        {cell.worktree && (
          <span className="branch" title={cell.worktree.path}><IBranch /> {cell.worktree.branch}</span>
        )}
        {status !== 'idle' && <span className={`status-text ${status}`}>{status === 'working' ? tr('pracuje') : status === 'waiting' ? tr('czeka na Ciebie') : tr('zakończony')}{status === 'working' ? '…' : ''}</span>}
        <span className="grow" />
        <span className="actions">
          <button title={tr("Uruchom ponownie")} onClick={(e) => openMenuAt(e.currentTarget, restartItems())}><IRestart /></button>
          <button title={maximized ? tr("Przywróć siatkę") + keyLabel("(Ctrl+Shift+M)") : tr("Maksymalizuj") + keyLabel("(Ctrl+Shift+M)")} onClick={() => toggleMaximize(cell.id)}>
            {maximized ? <IRestore /> : <IMax />}
          </button>
          <button title={tr("Zamknij komórkę")} onClick={() => void removeCell(cell.id)}><IX /></button>
        </span>
      </div>
      <div className="cell-body" ref={bodyRef} />
      {error && (
        <div className="cell-error">
          <span className="grow">{errorText(error)}</span>
          <button className="btn small" onClick={() => restartCell(cell.id, cell.session ? 'resume' : 'new')}>{tr("Spróbuj ponownie")}</button>
        </div>
      )}
    </div>
  );
}
