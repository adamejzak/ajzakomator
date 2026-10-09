import { keyLabel } from '../platform';
import { useI18n } from '../i18n';
import { activeProject, activeTab } from '../../../shared/state';
import { createProject, quickTab } from '../actions';
import { setUi, useStore } from '../store';
import { CellView } from './CellView';
import { IHistory, IPlus, Logo } from './icons';
import { ProjectIconView } from './ProjectIcon';

export function GridView() {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const maximized = useStore((st) => st.ui.maximizedCellId);
  const project = activeProject(s);
  const tab = activeTab(project);

  if (!project) {
    return (
      <div className="empty">
        <div className="welcome">
          <Logo size={56} />
          <h2>ajzakomator</h2>
          <div className="sub">{tr("Dodaj projekt, otwórz w nim grid terminali i odpal tyle Claude i Codexów, ile potrzebujesz.")}</div>
          <button className="btn white lg" onClick={() => void createProject()}><IPlus />  {tr("Nowy projekt")}</button>
          <div className="keys">
            <span><span className="kbd">{keyLabel("Ctrl+K")}</span>  {tr("Szukaj")}</span>
            <span><span className="kbd">{keyLabel("Ctrl+Shift+G")}</span>  {tr("Nowy grid")}</span>
            <span><span className="kbd">{keyLabel("Ctrl+Shift+N")}</span>  {tr("Dodaj agenta")}</span>
          </div>
        </div>
      </div>
    );
  }

  if (!tab) {
    return (
      <div className="empty">
        <div className="welcome">
          <ProjectIconView project={project} size="xl" />
          <h2>{project.name}</h2>
          <div className="sub">{tr("Otwórz grid terminali albo pojedynczy terminal z wybranym agentem.")}</div>
          <button className="btn white lg" onClick={() => setUi({ modal: { kind: 'grid', projectId: project.id } })}><IPlus />  {tr("Nowy grid")}</button>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
            {s.profiles.map((p) => (
              <button key={p.id} className="btn" onClick={() => quickTab(p.id)} title={tr("Nowa zakładka z jednym terminalem")}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /> {p.name}
              </button>
            ))}
          </div>
          <button className="btn ghost" onClick={() => setUi({ modal: { kind: 'history', projectId: project.id } })}>
            <IHistory />  {tr("Historia czatów i gridów")}
          </button>
          <div className="keys">
            <span><span className="kbd">{keyLabel("Ctrl+K")}</span>  {tr("Szukaj")}</span>
            <span><span className="kbd">{keyLabel("Ctrl+Shift+T")}</span>  {tr("Terminal")}</span>
            <span><span className="kbd">{keyLabel("Ctrl+Shift+G")}</span>  {tr("Grid")}</span>
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
