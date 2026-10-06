import { activeProject, activeTab } from '../../../shared/state';
import { createProject, quickTab } from '../actions';
import { setUi, useStore } from '../store';
import { CellView } from './CellView';
import { IFolder, IGrid } from './icons';

export function GridView() {
  const s = useStore((st) => st.s);
  const maximized = useStore((st) => st.ui.maximizedCellId);
  const project = activeProject(s);
  const tab = activeTab(project);

  if (!project) {
    return (
      <div className="empty">
        <div className="empty-inner">
          <h2>Witaj w MultiCoding</h2>
          <div className="hint">Dodaj projekt (folder), otwórz w nim grid terminali i odpal tyle Claude / Codex, ile potrzebujesz.</div>
          <div className="row"><button className="btn primary" onClick={() => void createProject()}><IFolder /> Dodaj projekt</button></div>
        </div>
      </div>
    );
  }

  if (!tab) {
    return (
      <div className="empty">
        <div className="empty-inner">
          <h2>{project.name}</h2>
          <div className="hint">Otwórz pojedynczy terminal albo cały grid.</div>
          <div className="row">
            {s.profiles.map((p) => (
              <button key={p.id} className="btn" onClick={() => quickTab(p.id)}>
                <span className="pchip" style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /> {p.name}
              </button>
            ))}
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => setUi({ modal: { kind: 'grid', projectId: project.id } })}><IGrid /> Grid / preset…</button>
            {project.archive.length > 0 && (
              <button className="btn" onClick={() => setUi({ modal: { kind: 'history', projectId: project.id } })}>Historia ({project.archive.length})</button>
            )}
          </div>
          <div className="hint">
            <span className="kbd">Ctrl+K</span> szukaj · <span className="kbd">Ctrl+Shift+T</span> terminal · <span className="kbd">Ctrl+Shift+G</span> grid ·{' '}
            <span className="kbd">Ctrl+Shift+N</span> + agent
          </div>
        </div>
      </div>
    );
  }

  const maxCell = maximized ? tab.cells.find((c) => c.id === maximized) : undefined;
  const { cols, rows } = tab.layout;
  return (
    <div
      className="grid"
      style={maxCell ? { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' } : { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {tab.cells.map((cell, i) => {
        if (maxCell && cell.id !== maxCell.id) return null;
        const a = tab.layout.areas[i] ?? tab.layout.areas[tab.layout.areas.length - 1];
        const style = maxCell
          ? { gridColumn: '1 / -1', gridRow: '1 / -1' }
          : { gridColumn: `${a.col + 1} / span ${a.colSpan}`, gridRow: `${a.row + 1} / span ${a.rowSpan}` };
        return <CellView key={cell.id} cell={cell} index={i} style={style} maximized={!!maxCell} />;
      })}
    </div>
  );
}
