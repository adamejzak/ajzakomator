import { useState } from 'react';
import { fuzzyFilter } from '../../../shared/fuzzy';
import type { Snippet } from '../../../shared/types';
import { sendSnippet } from '../actions';
import { setUi, useStore } from '../store';
import { SNIPPET_MIME } from './CellView';
import { IEdit, IPlus } from './icons';

export function SnippetPanel() {
  const snippets = useStore((st) => st.s.snippets);
  const projectId = useStore((st) => st.s.activeProjectId);
  const [q, setQ] = useState('');
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
        <span>Snippety</span>
        <button className="btn ghost icon small" title="Nowy snippet" onClick={() => setUi({ modal: { kind: 'snippet', snippetId: null } })}><IPlus /></button>
      </div>
      <input className="search" placeholder="Szukaj snippetów…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="snippets">
        {visible.map((sn) => (
          <div
            key={sn.id}
            className="snippet"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SNIPPET_MIME, JSON.stringify(sn));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the terminal */}
            onClick={(e) => use(sn, e.shiftKey)}
            title={'Klik: wklej do aktywnej komórki · Shift+klik: do wszystkich · przeciągnij na komórkę'}
          >
            <div className="s-head">
              <span className="s-name">{sn.name}</span>
              {sn.autoSend && <span className="tag green">↵ wyślij</span>}
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
        {!snippets.length && (
          <div className="muted" style={{ lineHeight: 1.6, padding: '4px 2px' }}>
            Zapisz prompty, których często używasz (np. „zrób review zmian”, „napisz testy”) i wklejaj je jednym kliknięciem.
          </div>
        )}
      </div>
      <div className="rpanel-foot">
        Klik → aktywna komórka · <b>Shift</b>+klik → wszystkie w siatce · przeciągnij na komórkę
      </div>
    </div>
  );
}
