import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getProfile } from '../../../shared/state';
import type { Cell } from '../../../shared/types';
import { changeCellProfile, ensureStarted, removeCell, restartCell, sendSnippet, toggleMaximize } from '../actions';
import { setUi, useStore } from '../store';
import { terminals } from '../terminals/TerminalManager';
import { openMenuAt } from './ContextMenu';
import { IBranch, IMax, IRestart, IRestore, IX } from './icons';

export const SNIPPET_MIME = 'application/x-mc-snippet';

const STATUS_LABEL = { idle: '', working: 'pracuje…', waiting: 'czeka na Ciebie', exited: 'zakończony' } as const;

export function CellView({ cell, index, style, maximized }: { cell: Cell; index: number; style: CSSProperties; maximized: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const profiles = useStore((st) => st.s.profiles);
  const profile = useStore((st) => getProfile(st.s, cell.profileId));
  const status = useStore((st) => st.ui.statuses[cell.id] ?? 'idle');
  const focused = useStore((st) => st.ui.focusedCellId === cell.id);
  const error = useStore((st) => st.ui.cellErrors[cell.id]);
  const epoch = useStore((st) => st.ui.epoch);
  const [drop, setDrop] = useState(false);

  useEffect(() => {
    const el = bodyRef.current!;
    ensureStarted(cell.id);
    terminals.attach(cell.id, el);
    return () => terminals.detach(cell.id, el);
  }, [cell.id, epoch]);

  const markFocused = () => {
    setUi({ focusedCellId: cell.id });
    terminals.acknowledge(cell.id);
  };

  const profileMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: 'Zmień profil (nowa rozmowa)' },
      ...profiles.map((p) => ({ label: p.name, onClick: () => changeCellProfile(cell.id, p.id) })),
    ]);

  const restartMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      ...(cell.session ? [{ label: 'Uruchom ponownie i wznów rozmowę', onClick: () => restartCell(cell.id, 'resume') }] : []),
      { label: profile.cli === 'shell' ? 'Uruchom ponownie' : 'Nowa rozmowa', onClick: () => restartCell(cell.id, 'new') },
    ]);

  return (
    <div
      className={`cell ${focused ? 'focused' : ''} ${drop ? 'drop' : ''}`}
      style={style}
      onMouseDownCapture={markFocused}
      onFocusCapture={markFocused}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SNIPPET_MIME)) return;
        e.preventDefault();
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
      <div className="cell-head" onDoubleClick={(e) => (e.target as HTMLElement).closest('button') || toggleMaximize(cell.id)}>
        <span className="idx">{index + 1}</span>
        <span className={`dot ${status}`} />
        <span className="profile" onClick={(e) => profileMenu(e.currentTarget)} title="Zmień profil">
          <span className="pchip" style={{ background: profile.color }} />
          {profile.name}
        </span>
        {cell.worktree && (
          <span className="branch" title={cell.worktree.path}><IBranch /> {cell.worktree.branch}</span>
        )}
        {status !== 'idle' && <span className={`status-text ${status}`}>{STATUS_LABEL[status]}</span>}
        <span className="grow" />
        <span className="actions">
          <button title="Uruchom ponownie" onClick={(e) => restartMenu(e.currentTarget)}><IRestart /></button>
          <button title={maximized ? 'Przywróć siatkę (Ctrl+Shift+M)' : 'Maksymalizuj (Ctrl+Shift+M)'} onClick={() => toggleMaximize(cell.id)}>
            {maximized ? <IRestore /> : <IMax />}
          </button>
          <button title="Zamknij komórkę" onClick={() => void removeCell(cell.id)}><IX /></button>
        </span>
      </div>
      <div className="cell-body" ref={bodyRef} />
      {error && (
        <div className="cell-error">
          <span className="grow">{error}</span>
          <button className="btn small" onClick={() => restartCell(cell.id, cell.session ? 'resume' : 'new')}>Spróbuj ponownie</button>
        </div>
      )}
    </div>
  );
}
