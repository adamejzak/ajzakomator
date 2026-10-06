import { useEffect, useMemo, useState } from 'react';
import { describeLayout } from '../../../shared/layout';
import {
  deleteArchived, getProfile, PROJECT_COLORS, removeProfile, removeSnippet, uid, updateProject, updateSettings, upsertProfile, upsertSnippet,
} from '../../../shared/state';
import { fuzzyFilter } from '../../../shared/fuzzy';
import type { CliKind, ProjectIcon, SessionInfo, ShellKind, Snippet } from '../../../shared/types';
import { relocateProject, restoreArchived, resumeSession } from '../actions';
import { closeDialog, closeModal, update, useStore, type Dialog } from '../store';
import { GridDialog } from './GridDialog';
import { IX } from './icons';

export function Modals() {
  const modal = useStore((st) => st.ui.modal);
  const dialog = useStore((st) => st.ui.dialog);

  useEffect(() => {
    if (!modal && !dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (dialog) closeDialog();
      else closeModal();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modal, dialog]);

  return (
    <>
      {modal && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
          {modal.kind === 'grid' && <GridDialog projectId={modal.projectId} />}
          {modal.kind === 'history' && <HistoryModal projectId={modal.projectId} />}
          {modal.kind === 'settings' && <SettingsModal />}
          {modal.kind === 'snippet' && <SnippetEditor snippetId={modal.snippetId} />}
          {modal.kind === 'project' && <ProjectEditor projectId={modal.projectId} />}
        </div>
      )}
      {dialog && (
        <div className="overlay" style={{ zIndex: 55 }} onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
          <DialogView dialog={dialog} />
        </div>
      )}
    </>
  );
}

function DialogView({ dialog }: { dialog: Dialog }) {
  const [value, setValue] = useState(dialog.kind === 'prompt' ? dialog.value : '');
  if (dialog.kind === 'prompt') {
    return (
      <div className="modal" style={{ width: 440 }}>
        <div className="modal-head"><h3>{dialog.title}</h3></div>
        <div className="modal-body">
          <input
            className="input"
            autoFocus
            value={value}
            placeholder={dialog.placeholder}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && dialog.onSubmit(value)}
          />
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={closeDialog}>Anuluj</button>
          <button className="btn primary" onClick={() => dialog.onSubmit(value)}>OK</button>
        </div>
      </div>
    );
  }
  return (
    <div className="modal" style={{ width: 460 }}>
      <div className="modal-head"><h3>{dialog.title}</h3></div>
      <div className="modal-body"><div className="muted" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{dialog.body}</div></div>
      <div className="modal-foot">
        <button className="btn" onClick={closeDialog}>Anuluj</button>
        {dialog.actions.map((a) => (
          <button key={a.value} autoFocus={a.primary} className={`btn ${a.danger ? 'danger' : ''} ${a.primary ? 'primary' : ''}`} onClick={() => dialog.onChoose(a.value)}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── history ─────────────────────────────────────────────────────────────────

const ago = (ms: number) => {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'przed chwilą';
  if (d < 3600) return `${Math.floor(d / 60)} min temu`;
  if (d < 86400) return `${Math.floor(d / 3600)} h temu`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} dni temu`;
  return new Date(ms).toLocaleDateString('pl-PL');
};

function HistoryModal({ projectId }: { projectId: string }) {
  const s = useStore((st) => st.s);
  const focused = useStore((st) => st.ui.focusedCellId);
  const project = s.projects.find((p) => p.id === projectId);
  const [view, setView] = useState<'archive' | 'sessions'>('sessions');
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (project) void window.mc.listSessions(project.path).then(setSessions);
  }, [project?.path]);

  const openIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of s.projects) for (const t of p.tabs) for (const c of t.cells) if (c.session) ids.add(c.session.id);
    return ids;
  }, [s.projects]);

  if (!project) return null;
  const isActive = s.activeProjectId === projectId;
  const list = fuzzyFilter(sessions ?? [], q, (x) => x.title, 300);
  const archive = fuzzyFilter(project.archive, q, (t) => t.name, 300);

  return (
    <div className="modal wide">
      <div className="modal-head">
        <h3>Historia · {project.name}</h3>
        <div className="tabs-switch">
          <button className={`btn small ${view === 'sessions' ? 'primary' : ''}`} onClick={() => setView('sessions')}>Czaty Claude / Codex {sessions ? `(${sessions.length})` : ''}</button>
          <button className={`btn small ${view === 'archive' ? 'primary' : ''}`} onClick={() => setView('archive')}>Zamknięte gridy ({project.archive.length})</button>
        </div>
        <button className="btn ghost icon" onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <input className="input" autoFocus placeholder="Szukaj…" value={q} onChange={(e) => setQ(e.target.value)} />
        {view === 'archive' && (
          <div className="hist-list">
            {archive.map((t) => (
              <div key={t.id} className="hist-item">
                <span className="htitle">{t.name} <span className="muted">· {describeLayout(t.layout)}</span></span>
                <span className="row" style={{ gap: 4 }}>
                  {t.cells.slice(0, 6).map((c) => {
                    const cli = getProfile(s, c.profileId).cli;
                    return <span key={c.id} className={`cli ${cli}`}>{cli}</span>;
                  })}
                  {t.cells.length > 6 && <span className="muted">+{t.cells.length - 6}</span>}
                </span>
                <span className="hmeta">{ago(t.closedAt)}</span>
                <button className="btn small primary" onClick={() => { closeModal(); restoreArchived(projectId, t.id); }}>Przywróć</button>
                <button className="btn small ghost icon" title="Usuń z historii" onClick={() => update((st) => deleteArchived(st, projectId, t.id))}><IX /></button>
              </div>
            ))}
            {!project.archive.length && <div className="muted">Zamknięte zakładki pojawią się tutaj razem z rozmowami, które w nich były.</div>}
          </div>
        )}
        {view === 'sessions' && (
          <div className="hist-list">
            {!sessions && <div className="muted">Wczytywanie…</div>}
            {list.map((x) => (
              <div key={x.cli + x.id} className="hist-item">
                <span className={`cli ${x.cli}`}>{x.cli}</span>
                <span className="htitle" title={x.title}>{x.title}</span>
                {openIds.has(x.id) && <span className="tag">otwarta</span>}
                <span className="hmeta">{ago(x.updatedAt)}</span>
                {isActive && (
                  <>
                    {focused && <button className="btn small" onClick={() => { closeModal(); resumeSession(x, 'cell'); }}>W aktywnej</button>}
                    <button className="btn small" onClick={() => { closeModal(); resumeSession(x, 'newCell'); }}>Nowa komórka</button>
                  </>
                )}
                <button className="btn small primary" onClick={() => { closeModal(); resumeSession(x, 'newTab'); }} disabled={!isActive}>Nowa zakładka</button>
              </div>
            ))}
            {sessions && !sessions.length && <div className="muted">Brak zapisanych rozmów Claude/Codex dla tego folderu.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── settings ────────────────────────────────────────────────────────────────

function SettingsModal() {
  const s = useStore((st) => st.s);
  const setSetting = (patch: Partial<typeof s.settings>) => update((st) => updateSettings(st, patch));
  return (
    <div className="modal wide">
      <div className="modal-head">
        <h3>Ustawienia</h3>
        <button className="btn ghost icon" onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <div className="field">
            <label>Rozmiar czcionki terminala (nowe komórki)</label>
            <input className="input" type="number" min={8} max={32} value={s.settings.fontSize} style={{ width: 120 }}
              onChange={(e) => setSetting({ fontSize: Math.max(8, Math.min(32, Number(e.target.value) || 13)) })} />
          </div>
          <div className="field">
            <label>Shell</label>
            <select className="select" value={s.settings.shell} onChange={(e) => setSetting({ shell: e.target.value as ShellKind })}>
              <option value="pwsh">PowerShell 7 (pwsh)</option>
              <option value="powershell">Windows PowerShell 5</option>
              <option value="cmd">cmd</option>
            </select>
          </div>
          <label className="check" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
            <input type="checkbox" checked={s.settings.notifications} onChange={(e) => setSetting({ notifications: e.target.checked })} />
            Powiadomienia Windows, gdy agent czeka na Ciebie
          </label>
        </div>
        <div className="section-title">Profile agentów</div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          Argumenty są dopisywane do polecenia, np. <code>--model opus</code>, <code>--dangerously-skip-permissions</code>, <code>-m gpt-5 -c model_reasoning_effort=high</code>.
        </div>
        {s.profiles.map((p) => (
          <div key={p.id} className="row">
            <input type="color" value={p.color} onChange={(e) => update((st) => upsertProfile(st, { ...p, color: e.target.value }))}
              style={{ width: 28, height: 28, padding: 0, border: 0, background: 'none' }} />
            <input className="input" style={{ width: 150 }} value={p.name} onChange={(e) => update((st) => upsertProfile(st, { ...p, name: e.target.value }))} />
            <select className="select" value={p.cli} onChange={(e) => update((st) => upsertProfile(st, { ...p, cli: e.target.value as CliKind }))}>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="shell">shell</option>
            </select>
            <input className="input" style={{ flex: 1, fontFamily: 'Cascadia Mono, Consolas, monospace' }} placeholder="argumenty CLI" value={p.args}
              disabled={p.cli === 'shell'} onChange={(e) => update((st) => upsertProfile(st, { ...p, args: e.target.value }))} />
            <button className="btn ghost icon" title="Usuń profil" onClick={() => update((st) => removeProfile(st, p.id))}><IX /></button>
          </div>
        ))}
        <div>
          <button className="btn" onClick={() => update((st) => upsertProfile(st, { id: uid(), name: 'Nowy profil', cli: 'claude', args: '', color: '#8b5cf6' }))}>+ Dodaj profil</button>
        </div>
      </div>
    </div>
  );
}

const SNIPPET_EMOJIS = ['🔍', '🧪', '🐛', '✨', '📝', '🚀', '♻️', '🔒', '📦', '🎨', '⚡', '🧹', '💬', '📊', '🛠️', '✅', '🔥', '🧠', '📋'];

// ── snippet editor ──────────────────────────────────────────────────────────

function SnippetEditor({ snippetId }: { snippetId: string | null }) {
  const s = useStore((st) => st.s);
  const existing = s.snippets.find((x) => x.id === snippetId);
  const [draft, setDraft] = useState<Snippet>(existing ?? { id: uid(), name: '', text: '', autoSend: false });
  const project = s.projects.find((p) => p.id === s.activeProjectId);
  const save = () => {
    if (!draft.text.trim()) return;
    update((st) => upsertSnippet(st, { ...draft, name: draft.name.trim() || draft.text.trim().split('\n')[0].slice(0, 40) }));
    closeModal();
  };
  return (
    <div className="modal">
      <div className="modal-head">
        <h3>{existing ? 'Edytuj snippet' : 'Nowy snippet'}</h3>
        <button className="btn ghost icon" onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <div className="field">
          <label>Nazwa</label>
          <input className="input" autoFocus value={draft.name} placeholder="np. Review zmian" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Treść promptu</label>
          <textarea className="textarea" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && save()} />
        </div>
        <div className="field">
          <label>Kolor</label>
          <div className="color-row">
            <button className={!draft.color ? 'on' : ''} style={{ background: '#2a2a2a' }} title="Bez koloru" onClick={() => setDraft({ ...draft, color: undefined })} />
            {PROJECT_COLORS.map((c) => (
              <button key={c} className={draft.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setDraft({ ...draft, color: c })} />
            ))}
          </div>
        </div>
        <div className="field">
          <label>Ikona</label>
          <div className="emoji-grid">
            <button className={!draft.icon ? 'on' : ''} title="Bez ikony" onClick={() => setDraft({ ...draft, icon: undefined })}><IX /></button>
            {SNIPPET_EMOJIS.map((e) => (
              <button key={e} className={draft.icon === e ? 'on' : ''} onClick={() => setDraft({ ...draft, icon: e })}>{e}</button>
            ))}
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={draft.autoSend} onChange={(e) => setDraft({ ...draft, autoSend: e.target.checked })} /> Od razu wyślij (Enter po wklejeniu)</label>
        {project && (
          <label className="check">
            <input type="checkbox" checked={!!draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.checked ? project.id : undefined })} />
            Tylko w projekcie „{project.name}”
          </label>
        )}
      </div>
      <div className="modal-foot">
        {existing && <button className="btn danger" onClick={() => { update((st) => removeSnippet(st, existing.id)); closeModal(); }}>Usuń</button>}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={closeModal}>Anuluj</button>
        <button className="btn primary" onClick={save}>Zapisz <span className="kbd">Ctrl+Enter</span></button>
      </div>
    </div>
  );
}

// ── project editor ──────────────────────────────────────────────────────────

const EMOJIS = ['📁', '🚀', '🤖', '⚡', '🔥', '🎯', '💎', '🧠', '🛠️', '🌐', '📦', '🎮', '🧪', '📊', '💬', '🔒', '🎨', '🦄', '🐙', '☕'];

/** Downscales an image file to a 96×96 PNG data URL (keeps state.json small). */
function readIcon(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const size = 96;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Nie udało się wczytać obrazka'));
    img.src = url;
  });
}

function ProjectEditor({ projectId }: { projectId: string }) {
  const project = useStore((st) => st.s.projects.find((p) => p.id === projectId));
  const [name, setName] = useState(project?.name ?? '');
  if (!project) return null;
  const setIcon = (icon: ProjectIcon | undefined) => update((st) => updateProject(st, projectId, { icon }));
  const save = () => {
    if (name.trim()) update((st) => updateProject(st, projectId, { name: name.trim() }));
    closeModal();
  };
  const icon = project.icon;
  return (
    <div className="modal">
      <div className="modal-head">
        <h3>Edytuj projekt</h3>
        <button className="btn ghost icon" onClick={closeModal}><IX /></button>
      </div>
      <div className="modal-body">
        <div className="row" style={{ gap: 14 }}>
          <div className="picon-preview" style={{ background: icon?.kind === 'image' ? undefined : project.color + (icon ? '33' : '') }}>
            {icon?.kind === 'image' && <img src={icon.dataUrl} alt="" />}
            {icon?.kind === 'emoji' && icon.value}
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Nazwa</label>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            <span className="muted" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={project.path}>{project.path}</span>
          </div>
        </div>
        <div className="field">
          <label>Kolor</label>
          <div className="color-row">
            {PROJECT_COLORS.map((c) => (
              <button key={c} className={c === project.color ? 'on' : ''} style={{ background: c }} onClick={() => update((st) => updateProject(st, projectId, { color: c }))} />
            ))}
          </div>
        </div>
        <div className="field">
          <label>Ikona</label>
          <div className="emoji-grid">
            {EMOJIS.map((e) => (
              <button key={e} className={icon?.kind === 'emoji' && icon.value === e ? 'on' : ''} onClick={() => setIcon({ kind: 'emoji', value: e })}>{e}</button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <label className="btn" style={{ cursor: 'pointer' }}>
              Wgraj własną ikonę…
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setIcon({ kind: 'image', dataUrl: await readIcon(file) });
              }} />
            </label>
            {icon && <button className="btn ghost" onClick={() => setIcon(undefined)}>Usuń ikonę</button>}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={() => { closeModal(); void relocateProject(projectId); }}>Zmień folder…</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={closeModal}>Anuluj</button>
        <button className="btn white" onClick={save}>Zapisz</button>
      </div>
    </div>
  );
}
