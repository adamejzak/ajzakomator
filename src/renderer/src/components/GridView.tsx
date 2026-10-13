import { shortcutText } from '../shortcuts';
import { useI18n } from '../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { areaRects, type GridLayout } from '../../../shared/layout';
import { activeProject, activeTab, getProfile, setTabLayout } from '../../../shared/state';
import { createProject, quickTab, swapCellSlots } from '../actions';
import { playCellMotion } from '../gridMotion';
import { getUi, setUi, update, useStore } from '../store';
import { profileOptionLabel } from '../cliUi';
import { useCellDrag, type DragContext } from './useCellDrag';
import { CellView } from './CellView';
import { areaStyle, GridDividers } from './GridDividers';
import { IHistory, IPlus, Logo } from './icons';
import { ProjectIconView } from './ProjectIcon';

/** The key of an action as a chip; nothing while the shortcut is switched off. */
function Kbd({ id }: { id: string }) {
  const text = shortcutText(id);
  return text ? <span className="kbd">{text}</span> : null;
}

export function GridView() {
  const { tr } = useI18n();
  const s = useStore((st) => st.s);
  const maximized = useStore((st) => st.ui.maximizedCellId);
  const cliStatus = useStore((st) => st.ui.cliStatus);
  const project = activeProject(s);
  const tab = activeTab(project);
  const [preview, setPreview] = useState<{ tabId: string; layout: GridLayout } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cellOrder = tab ? tab.cells.map((c) => c.id).join() : '';
  const { drag, ghostRef, onHeadPointerDown, cancel } = useCellDrag(
    (): DragContext | null => (tab && gridRef.current
      ? { grid: gridRef.current, ids: tab.cells.map((c) => c.id), rects: areaRects(tab.layout) }
      : null),
    swapCellSlots,
  );

  // A drag belongs to one grid: leaving the tab or project, or maximizing a cell, aborts it.
  useEffect(() => { cancel(); }, [cancel, project?.id, tab?.id, maximized]);

  // Cells that changed slots slide from their old position (see gridMotion.ts).
  useLayoutEffect(() => { playCellMotion(); }, [cellOrder]);

  if (!project) {
    return (
      <div className="empty">
        <div className="welcome">
          <Logo size={56} />
          <h2>ajzakomator</h2>
          <div className="sub">{tr("Dodaj projekt, otwórz w nim grid terminali i odpal tyle Claude i Codexów, ile potrzebujesz.")}</div>
          <button className="btn white lg" onClick={() => void createProject()}><IPlus />  {tr("Nowy projekt")}</button>
          <div className="keys">
            <span><Kbd id="palette.open" />  {tr("Szukaj")}</span>
            <span><Kbd id="grid.new" />  {tr("Nowy grid")}</span>
            <span><Kbd id="agent.add" />  {tr("Dodaj agenta")}</span>
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
                <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /> {profileOptionLabel(p, cliStatus, tr)}
              </button>
            ))}
          </div>
          <button className="btn ghost" onClick={() => setUi({ modal: { kind: 'history', projectId: project.id } })}>
            <IHistory />  {tr("Historia czatów i gridów")}
          </button>
          <div className="keys">
            <span><Kbd id="palette.open" />  {tr("Szukaj")}</span>
            <span><Kbd id="terminal.new" />  {tr("Terminal")}</span>
            <span><Kbd id="grid.new" />  {tr("Grid")}</span>
          </div>
        </div>
      </div>
    );
  }

  const maxCell = maximized ? tab.cells.find((c) => c.id === maximized) : undefined;
  const layout = preview?.tabId === tab.id ? preview.layout : tab.layout;
  const rects = areaRects(layout);
  const canDrag = !maxCell && tab.cells.length > 1;
  const dragged = drag ? tab.cells.find((c) => c.id === drag.id) : undefined;
  const targetIndex = drag?.target ? tab.cells.findIndex((c) => c.id === drag.target) : -1;
  const draggedLabel = dragged && (dragged.name ?? (dragged.session ? getUi().sessionTitles[dragged.session.id] : undefined) ?? getProfile(s, dragged.profileId).name);
  return (
    <div ref={gridRef} className={`grid ${preview ? 'resizing' : ''} ${drag ? 'dragging' : ''}`}>
      {tab.cells.map((cell, i) => {
        if (maxCell && cell.id !== maxCell.id) return null;
        const rect = rects[i] ?? rects[rects.length - 1];
        const style = maxCell ? { left: 0, top: 0, width: '100%', height: '100%' } : areaStyle(rect);
        return <CellView key={cell.id} cell={cell} index={i} style={style} maximized={!!maxCell}
          dragSource={drag?.id === cell.id} onHeadPointerDown={canDrag ? onHeadPointerDown : undefined} />;
      })}
      {targetIndex >= 0 && rects[targetIndex] && (
        <div className="cell-drop-target" style={areaStyle(rects[targetIndex])}><span>{tr('Zamień miejscami')}</span></div>
      )}
      {dragged && (
        <div className="cell-ghost" ref={ghostRef}>
          <span className="pchip" style={{ background: getProfile(s, dragged.profileId).color }} />
          <b>{tab.cells.indexOf(dragged) + 1}</b>
          <span className="name">{draggedLabel}</span>
        </div>
      )}
      {!maxCell && tab.cells.length > 1 && (
        <GridDividers
          layout={layout}
          onPreview={(next) => setPreview(next && { tabId: tab.id, layout: next })}
          onCommit={(next) => update((st) => setTabLayout(st, project.id, tab.id, next))}
        />
      )}
    </div>
  );
}
