import { useEffect, useState } from 'react';
import { createLayout, describeLayout, layoutForCount, MAX_COLS, MAX_ROWS, mergeRect, unmergeAll, type GridLayout } from '../../../shared/layout';
import { removePreset, uid, upsertPreset } from '../../../shared/state';
import type { PresetCell } from '../../../shared/types';
import { openTab } from '../actions';
import { askChoice, askText, closeModal, update, useStore } from '../store';
import { IX } from './icons';

const QUICK = [1, 2, 4, 6, 9, 12];

export function GridDialog({ projectId }: { projectId: string }) {
  const s = useStore((st) => st.s);
  const project = s.projects.find((p) => p.id === projectId);
  const defaultProfile = s.settings.lastProfileId;
  const [layout, setLayout] = useState<GridLayout>(createLayout(2, 2));
  const [cells, setCells] = useState<PresetCell[]>(() => Array(20).fill(null).map(() => ({ profileId: defaultProfile, worktree: false })));
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [name, setName] = useState('');
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  useEffect(() => {
    if (project) void window.mc.isGitRepo(project.path).then(setIsRepo);
  }, [project?.path]);

  if (!project) return null;
  const presets = s.presets.filter((p) => !p.projectId || p.projectId === projectId);
  const n = layout.areas.length;

  const pickSize = (c: number, r: number) => {
    setLayout(createLayout(c, r));
    setSelected(new Set());
  };
  const setCell = (i: number, patch: Partial<PresetCell>) => setCells((cs) => cs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setAll = (patch: Partial<PresetCell>) => setCells((cs) => cs.map((x) => ({ ...x, ...patch })));

  const merge = () => {
    const areas = [...selected].map((i) => layout.areas[i]);
    if (areas.length < 2) return;
    const col = Math.min(...areas.map((a) => a.col));
    const row = Math.min(...areas.map((a) => a.row));
    const rect = {
      col, row,
      colSpan: Math.max(...areas.map((a) => a.col + a.colSpan)) - col,
      rowSpan: Math.max(...areas.map((a) => a.row + a.rowSpan)) - row,
    };
    setLayout(mergeRect(layout, rect));
    setSelected(new Set());
  };

  const open = () => {
    closeModal();
    void openTab(projectId, layout, cells.slice(0, n), name.trim() || undefined);
  };

  const savePreset = async () => {
    const presetName = await askText('Nazwa presetu', name || `${describeLayout(layout)} ${s.profiles.find((p) => p.id === cells[0].profileId)?.name ?? ''}`.trim());
    if (!presetName?.trim()) return;
    const scope = await askChoice('Gdzie zapisać preset?', 'Preset globalny jest dostępny we wszystkich projektach.', [
      { label: 'Tylko ten projekt', value: 'project' },
      { label: 'Globalnie', value: 'global', primary: true },
    ]);
    if (scope) {
      const preset = { id: uid(), name: presetName.trim(), layout, cells: cells.slice(0, n), ...(scope === 'project' ? { projectId } : {}) };
      update((st) => upsertPreset(st, preset));
    }
  };

  const loadPreset = (id: string) => {
    const p = s.presets.find((x) => x.id === id);
    if (!p) return;
    setLayout(p.layout);
    setCells((cs) => cs.map((x, i) => p.cells[i] ?? x));
    setSelected(new Set());
  };

  const hc = hover?.c ?? layout.cols;
  const hr = hover?.r ?? layout.rows;

  return (
    <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head">
        <h3>Nowy grid · {project.name}</h3>
        <button className="btn ghost icon" onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <div className="presets">
          {QUICK.map((q) => (
            <button key={q} className="btn small" onClick={() => setLayout(layoutForCount(q))}>{describeLayout(layoutForCount(q))}</button>
          ))}
          {presets.length > 0 && <span className="muted" style={{ alignSelf: 'center', margin: '0 4px' }}>·</span>}
          {presets.map((p) => (
            <span key={p.id} className="btn small" onClick={() => loadPreset(p.id)} title={p.projectId ? 'Preset projektu' : 'Preset globalny'}>
              {p.name}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  update((st) => removePreset(st, p.id));
                }}
                title="Usuń preset"
                style={{ opacity: 0.6, display: 'grid' }}
              >
                <IX />
              </span>
            </span>
          ))}
        </div>
        <div className="grid-dialog">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <div className="picker" onMouseLeave={() => setHover(null)}>
              {Array.from({ length: MAX_ROWS }, (_, r) =>
                Array.from({ length: MAX_COLS }, (_, c) => (
                  <div
                    key={`${c}-${r}`}
                    className={`f ${c < hc && r < hr ? 'on' : ''}`}
                    onMouseEnter={() => setHover({ c: c + 1, r: r + 1 })}
                    onClick={() => pickSize(c + 1, r + 1)}
                  />
                )),
              )}
            </div>
            <div className="big-size">{hover ? `${hover.c} × ${hover.r}` : describeLayout(layout).replace('×', ' × ')}</div>
            <div className="row">
              <button className="btn small" disabled={selected.size < 2} onClick={merge} title="Zaznacz komórki w podglądzie (klik), potem scal">Scal</button>
              <button className="btn small" onClick={() => setLayout(unmergeAll(layout))}>Rozdziel</button>
              <button className="btn small" onClick={() => setSelected(new Set())}>Wyczyść</button>
            </div>
            <div className="muted" style={{ fontSize: 11, textAlign: 'center' }}>Klik w komórki podglądu zaznacza je do scalenia.</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            <div className="row">
              <span className="muted" style={{ width: 92 }}>Wszystkie:</span>
              <select className="select" style={{ flex: 1 }} value="" onChange={(e) => e.target.value && setAll({ profileId: e.target.value })}>
                <option value="">ustaw profil dla wszystkich…</option>
                {s.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {isRepo && (
                <label className="check"><input type="checkbox" onChange={(e) => setAll({ worktree: e.target.checked })} /> worktree</label>
              )}
            </div>
            <div className="preview" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0,1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0,1fr))` }}>
              {layout.areas.map((a, i) => (
                <div
                  key={i}
                  className={`pc ${selected.has(i) ? 'sel' : ''}`}
                  style={{ gridColumn: `${a.col + 1} / span ${a.colSpan}`, gridRow: `${a.row + 1} / span ${a.rowSpan}` }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('select,label')) return;
                    setSelected((sel) => {
                      const next = new Set(sel);
                      next.has(i) ? next.delete(i) : next.add(i);
                      return next;
                    });
                  }}
                >
                  <span className="n">{i + 1}</span>
                  <select value={cells[i].profileId} onChange={(e) => setCell(i, { profileId: e.target.value })}>
                    {s.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  {isRepo && (
                    <label><input type="checkbox" checked={cells[i].worktree} onChange={(e) => setCell(i, { worktree: e.target.checked })} /> worktree</label>
                  )}
                </div>
              ))}
            </div>
            <div className="row">
              <input className="input" style={{ flex: 1 }} placeholder="Nazwa zakładki (opcjonalnie)" value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && open()} />
            </div>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => void savePreset()}>Zapisz jako preset</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={closeModal}>Anuluj</button>
        <button className="btn primary" onClick={open}>Otwórz grid ({n})</button>
      </div>
    </div>
  );
}
