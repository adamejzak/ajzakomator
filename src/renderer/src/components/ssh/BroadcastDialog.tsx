// "Wyślij do wszystkich" (spec 10.5, D10): one command to the checked SSH cells of a grid, over the existing data port.
import { useMemo, useRef, useState } from 'react';
import { broadcastProblem, broadcastRowState, broadcastSend, broadcastTargets, pushHistory, sshCellsOfTab, type BroadcastResult } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { closeModal, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { terminals } from '../../terminals/TerminalManager';
import { IX } from '../icons';

let history: string[] = [];

export function BroadcastDialog({ projectId, tabId }: { projectId: string; tabId: string }) {
  const { tr } = useI18n();
  const tab = useStore((st) => st.s.projects.find((p) => p.id === projectId)?.tabs.find((t) => t.id === tabId));
  const hosts = useStore((st) => st.s.sshHosts);
  const sessions = useSshStore((st) => st.sessions);
  const prompts = useSshStore((st) => st.prompts);
  const cells = useMemo(() => (tab ? sshCellsOfTab(tab, hosts) : []), [tab, hosts]);
  const rows = broadcastTargets(cells, sessions, prompts);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [enter, setEnter] = useState(true);
  const [text, setText] = useState('');
  const [results, setResults] = useState<Record<string, BroadcastResult>>({});
  const [recall, setRecall] = useState<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const checked = rows.filter((r) => r.enabled && !unchecked.has(r.cellId));
  const problem = broadcastProblem(text);

  const send = () => {
    if (!text.trim() || problem || !checked.length) return;
    // Connected is decided at send time, not when the dialog was opened.
    const next = broadcastSend(checked.map((r) => r.cellId), useSshStore.getState().sessions, text, enter, (cellId, t, submit) => terminals.paste(cellId, t, submit, { focus: false }));
    setResults(next);
    history = pushHistory(history, text);
    setText('');
    setRecall(null);
    area.current?.focus();
  };

  return (
    <div className="modal ssh-broadcast" onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-head"><h3>{tr('Wyślij do wszystkich')}{tab ? ` · ${tab.name}` : ''}</h3><button className="btn ghost icon" aria-label={tr('Zamknij')} onClick={closeModal}><IX /></button></div>
      <div className="modal-body">
        {!cells.length ? <p className="muted">{tr('Ta siatka nie ma sesji SSH')}</p> : <>
          <textarea ref={area} className="input mono" rows={4} autoFocus spellCheck={false} value={text}
            onChange={(e) => { setText(e.target.value); setRecall(null); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
              if (e.key === 'ArrowUp' && (!text || recall !== null) && history.length) {
                e.preventDefault();
                const i = recall === null ? history.length - 1 : Math.max(0, recall - 1);
                setRecall(i); setText(history[i]);
              }
              if (e.key === 'Escape') closeModal();
            }} />
          {problem && <div className="ssh-error" role="alert">{tr(problem)}</div>}
          <label className="check"><input type="checkbox" checked={enter} onChange={(e) => setEnter(e.target.checked)} /> {tr('Naciśnij Enter po wysłaniu')}</label>
          <div className="ssh-row">
            <button className="btn small ghost" onClick={() => setUnchecked(new Set())}>{tr('Zaznacz wszystkie')}</button>
            <button className="btn small ghost" onClick={() => setUnchecked(new Set(rows.map((r) => r.cellId)))}>{tr('Odznacz wszystkie')}</button>
          </div>
          <ul className="ssh-targets">
            {rows.map((r) => (
              <li key={r.cellId} className={r.enabled ? '' : 'disabled'}>
                <label className="check">
                  <input type="checkbox" disabled={!r.enabled} checked={r.enabled && !unchecked.has(r.cellId)}
                    onChange={(e) => setUnchecked((u) => { const n = new Set(u); if (e.target.checked) n.delete(r.cellId); else n.add(r.cellId); return n; })} />
                  <span className="grow">{r.label}</span><span className="muted">{r.endpoint}</span>
                </label>
                <span className="ssh-target-state">{(() => { const key = broadcastRowState(r, results[r.cellId]); return key ? tr(key) : ''; })()}</span>
              </li>
            ))}
          </ul>
        </>}
      </div>
      <div className="modal-foot">
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={closeModal}>{tr('Zamknij')}</button>
        <button className="btn white" disabled={!text.trim() || !!problem || !checked.length} onClick={send}>{tr('Wyślij do {count}', { count: checked.length })}</button>
      </div>
    </div>
  );
}
