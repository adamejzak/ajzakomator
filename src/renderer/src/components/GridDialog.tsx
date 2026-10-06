import { useEffect, useState } from 'react';
import { createLayout, describeLayout, layoutForCount, MAX_COLS, MAX_ROWS, mergeRect, unmergeAll, type GridLayout } from '../../../shared/layout';
import { getProfile, removePreset, uid, upsertPreset } from '../../../shared/state';
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
  const [cells, setCells] = useState<PresetCell[]>(() => Array.from({ length: 20 }, () => ({ profileId: defaultProfile, worktree: false })));
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [name, setName] = useState('');
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  useEffect(() => {
    if (project) void window.mc.isGitRepo(project.path).then(setIsRepo);
  }, [project?.path]);

  if (!project) return null;
  const presets = s.presets.filter((p) => !p.projectId || p.projectId === projectId);
  const snippets = s.snippets.filter((x) => !x.projectId || x.projectId === projectId);
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
    setLayout(mergeRect(layout, {
      col, row,
      colSpan: Math.max(...areas.map((a) => a.col + a.colSpan)) - col,
      rowSpan: Math.max(...areas.map((a) => a.row + a.rowSpan)) - row,
    }));
    setSelected(new Set());
  };

  const open = () => {
    closeModal();
    void openTab(projectId, layout, cells.slice(0, n), name.trim() || undefined);
  };

  const savePreset = async () => {
    const presetName = await askText('Nazwa presetu', name || `${describeLayout(layout)} ${getProfile(s, cells[0].profileId).name}`);
    if (!presetName?.trim()) return;
    const scope = await askChoice('Gdzie zapisać preset?', 'Preset globalny jest dostępny we wszystkich projektach.', [
      { label: 'Tylko ten projekt', value: 'project' },
      { label: 'Globalnie', value: 'global', primary: true },
    ]);
    if (!scope) return;
    const preset = { id: uid(), name: presetName.trim(), layout, cells: cells.slice(0, n), ...(scope === 'project' ? { projectId } : {}) };
    update((st) => upsertPreset(st, preset));
  };

  const loadPreset = (id: string) => {
    const p = s.presets.find((x) => x.id === id);
    if (!p) return;
    setLayout(p.layout);
    setCells((cs) => cs.map((x, i) => p.cells[i] ?? { ...x, name: undefined, prompt: undefined }));
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
            <button key={q} className="btn small" onClick={() => { setLayout(layoutForCount(q)); setSelected(new Set()); }}>
              {describeLayout(layoutForCount(q))}
            </button>
          ))}
          {presets.length > 0 && <span className="muted" style={{ alignSelf: 'center', margin: '0 4px' }}>·</span>}
          {presets.map((p) => (
            <span key={p.id} className="btn small" onClick={() => loadPreset(p.id)} title={p.projectId ? 'Preset projektu' : 'Preset globalny'}>
              {p.name}
              <span onClick={(e) => { e.stopPropagation(); update((st) => removePreset(st, p.id)); }} title="Usuń preset" style={{ opacity: 0.6, display: 'grid' }}>
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
                  <div key={`${c}-${r}`} className={`f ${c < hc && r < hr ? 'on' : ''}`}
                    onMouseEnter={() => setHover({ c: c + 1, r: r + 1 })} onClick={() => pickSize(c + 1, r + 1)} />
                )),
              )}
            </div>
            <div className="big-size">{hover ? `${hover.c} × ${hover.r}` : describeLayout(layout).replace('×', ' × ')}</div>
            <div className="row">
              <button className="btn small" disabled={selected.size < 2} onClick={merge}>Scal</button>
              <button className="btn small" onClick={() => setLayout(unmergeAll(layout))}>Rozdziel</button>
              <button className="btn small" onClick={() => setSelected(new Set())}>Wyczyść</button>
            </div>
            <div className="muted" style={{ fontSize: 11, textAlign: 'center' }}>Kliknij komórki w podglądzie, żeby zaznaczyć je do scalenia.</div>
          </div>

          <div className="preview" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0,1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0,1fr))` }}>
            {layout.areas.map((a, i) => {
              const prof = getProfile(s, cells[i].profileId);
              return (
                <div
                  key={i}
                  className={`pc ${selected.has(i) ? 'sel' : ''}`}
                  style={{ gridColumn: `${a.col + 1} / span ${a.colSpan}`, gridRow: `${a.row + 1} / span ${a.rowSpan}`, cursor: 'pointer' }}
                  onClick={() => setSelected((sel) => {
                    const next = new Set(sel);
                    next.has(i) ? next.delete(i) : next.add(i);
                    return next;
                  })}
                >
                  <span className="n">{i + 1}</span>
                  <span className="pname">{cells[i].name || <span className="muted">bez nazwy</span>}</span>
                  <span className="pprof"><i style={{ background: prof.color }} />{prof.name}{cells[i].worktree ? ' · worktree' : ''}</span>
                  {cells[i].prompt && <span className="pprof">↳ prompt startowy</span>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <span className="section-title" style={{ margin: 0, flex: 1 }}>Komórki</span>
          <select className="select" value="" onChange={(e) => e.target.value && setAll({ profileId: e.target.value })}>
            <option value="">profil dla wszystkich…</option>
            {s.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {snippets.length > 0 && (
            <select className="select" value="" onChange={(e) => {
              const sn = snippets.find((x) => x.id === e.target.value);
              if (sn) setAll({ prompt: sn.text });
            }}>
              <option value="">prompt dla wszystkich…</option>
              {snippets.map((sn) => <option key={sn.id} value={sn.id}>{sn.name}</option>)}
            </select>
          )}
          {isRepo && <label className="check"><input type="checkbox" onChange={(e) => setAll({ worktree: e.target.checked })} /> worktree dla wszystkich</label>}
        </div>

        <div className="cell-table">
          <span className="hd" />
          <span className="hd">Nazwa</span>
          <span className="hd">Profil</span>
          <span className="hd">Prompt startowy</span>
          <span className="hd">{isRepo ? 'Worktree' : ''}</span>
          {layout.areas.map((_, i) => (
            <CellRow
              key={i}
              index={i}
              cell={cells[i]}
              profiles={s.profiles}
              snippets={snippets}
              isRepo={!!isRepo}
              onChange={(patch) => setCell(i, patch)}
            />
          ))}
        </div>

        <input className="input" placeholder="Nazwa zakładki (opcjonalnie)" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && open()} />
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => void savePreset()}>Zapisz jako preset</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={closeModal}>Anuluj</button>
        <button className="btn white" onClick={open}>Otwórz grid ({n})</button>
      </div>
    </div>
  );
}

function CellRow({ index, cell, profiles, snippets, isRepo, onChange }: {
  index: number;
  cell: PresetCell;
  profiles: Array<{ id: string; name: string; cli: string }>;
  snippets: Array<{ id: string; name: string; text: string }>;
  isRepo: boolean;
  onChange: (patch: Partial<PresetCell>) => void;
}) {
  const isShell = profiles.find((p) => p.id === cell.profileId)?.cli === 'shell';
  return (
    <>
      <span className="num">{index + 1}</span>
      <input className="input" placeholder="np. backend" value={cell.name ?? ''} onChange={(e) => onChange({ name: e.target.value })} />
      <select className="select" value={cell.profileId} onChange={(e) => onChange({ profileId: e.target.value })}>
        {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <span className="prompt-wrap">
        <input
          className="input"
          disabled={isShell}
          placeholder={isShell ? '—' : 'pierwsza wiadomość dla agenta (opcjonalnie)'}
          value={isShell ? '' : (cell.prompt ?? '')}
          title={cell.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
        {!isShell && snippets.length > 0 && (
          <select className="select" value="" title="Wstaw snippet" onChange={(e) => {
            const sn = snippets.find((x) => x.id === e.target.value);
            if (sn) onChange({ prompt: sn.text });
          }}>
            <option value="">⋯</option>
            {snippets.map((sn) => <option key={sn.id} value={sn.id}>{sn.name}</option>)}
          </select>
        )}
      </span>
      <span>{isRepo && <input type="checkbox" checked={cell.worktree} onChange={(e) => onChange({ worktree: e.target.checked })} />}</span>
    </>
  );
}
