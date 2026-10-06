import { useState } from 'react';
import { fuzzyFilter } from '../../../shared/fuzzy';
import type { Snippet } from '../../../shared/types';
import { sendSnippet } from '../actions';
import { moveSnippet } from '../../../shared/state';
import { setUi, update, useStore } from '../store';
import { SNIPPET_MIME } from './CellView';
import { IEdit, IPlus, ISnippet } from './icons';

export function SnippetPanel() {
  const snippets = useStore((st) => st.s.snippets);
  const projectId = useStore((st) => st.s.activeProjectId);
  const [q, setQ] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const visible = fuzzyFilter(
    snippets.filter((sn) => !sn.projectId || sn.projectId === projectId),
    q,
    (sn) => `${sn.name} ${sn.text}`,
    500,
  );

  const use = (sn: Snippet, all: boolean) => sendSnippet(sn, all ? 'all' : 'focused');

  return (
    <div className="rpanel">
      <div className="side-title">
        <span className="row" style={{ gap: 6 }}>
          Snippety
          <span className="help">
            ?
            <span className="help-pop">
              <span className="kbd">Klik</span><span>wklej do aktywnej komórki</span>
              <span className="kbd">Shift + klik</span><span>wklej do wszystkich</span>
              <span className="kbd">Przeciągnij</span><span>na komórkę albo zmień kolejność</span>
            </span>
          </span>
        </span>
        <button className="sq" title="Nowy snippet" onClick={() => setUi({ modal: { kind: 'snippet', snippetId: null } })}><IPlus /></button>
      </div>
      {!snippets.length ? (
        <div className="empty-state">
          <div className="es-icon"><ISnippet /></div>
          <div className="es-title">Brak snippetów</div>
          <div className="es-text">Zapisz prompty, których często używasz, i wklejaj je do terminali jednym kliknięciem.</div>
          <button className="btn white lg" onClick={() => setUi({ modal: { kind: 'snippet', snippetId: null } })}><IPlus /> Nowy snippet</button>
        </div>
      ) : (
      <>
      <input className="search" placeholder="Szukaj snippetów…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="snippets">
        {visible.map((sn) => (
          <div
            key={sn.id}
            className={`snippet ${dragId === sn.id ? 'dragging' : ''} ${overId === sn.id && dragId !== sn.id ? 'drag-over' : ''}`}
            style={sn.color ? ({ '--sc': sn.color } as React.CSSProperties) : undefined}
            data-colored={sn.color ? '' : undefined}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SNIPPET_MIME, JSON.stringify(sn));
              e.dataTransfer.effectAllowed = 'copyMove';
              setDragId(sn.id);
            }}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              setOverId(sn.id);
            }}
            onDrop={(e) => {
              if (!dragId) return;
              e.preventDefault();
              update((st) => moveSnippet(st, dragId, sn.id));
              setDragId(null);
              setOverId(null);
            }}
            onClick={(e) => use(sn, e.shiftKey)}
            title={'Klik: wklej do aktywnej komórki · Shift+klik: do wszystkich · przeciągnij na komórkę'}
          >
            <div className="s-head">
              {sn.icon && <span className="s-icon">{sn.icon}</span>}
              <span className="s-name">{sn.name}</span>
              {sn.projectId && <span className="tag">projekt</span>}
              <button
                className="btn ghost icon small s-edit"
                onClick={(e) => {
                  e.stopPropagation();
                  setUi({ modal: { kind: 'snippet', snippetId: sn.id } });
                }}
              >
                <IEdit />
              </button>
            </div>
            <div className="s-text">{sn.text}</div>
          </div>
        ))}
        {!visible.length && <div className="muted" style={{ padding: '8px 2px' }}>Nic nie pasuje do „{q}”.</div>}
      </div>
      </>
      )}
    </div>
  );
}
