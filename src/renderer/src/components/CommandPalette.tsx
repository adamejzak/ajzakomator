import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '../../../shared/fuzzy';
import { describeLayout } from '../../../shared/layout';
import { activeProject, activeTab } from '../../../shared/state';
import type { SessionInfo } from '../../../shared/types';
import {
  addAgent, closeTab, createProject, openTab, quickTab, restartCell, restoreArchived, resumeSession, selectTab,
  sendSnippet, switchProject, toggleMaximize,
} from '../actions';
import { getS, getUi, setUi, update, useStore } from '../store';

interface Item {
  kind: string;
  title: string;
  desc?: string;
  run: (shift: boolean) => void;
}

export function CommandPalette() {
  const open = useStore((st) => st.ui.palette);
  if (!open) return null;
  return <PaletteInner />;
}

function PaletteInner() {
  const s = useStore((st) => st.s);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const project = activeProject(s);

  useEffect(() => {
    if (project) void window.mc.listSessions(project.path).then(setSessions);
  }, [project?.path]);

  const close = () => setUi({ palette: false });

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const tab = activeTab(project);
    const focused = getUi().focusedCellId;
    // actions first so short queries like "his" / "ust" find them
    out.push({ kind: 'akcja', title: 'Nowy projekt…', run: () => void createProject() });
    if (project) {
      out.push({ kind: 'akcja', title: 'Nowy grid / preset…', desc: 'Ctrl+Shift+G', run: () => setUi({ modal: { kind: 'grid', projectId: project.id } }) });
      out.push({ kind: 'akcja', title: 'Nowy terminal (zakładka)', desc: 'Ctrl+Shift+T', run: () => quickTab() });
      out.push({ kind: 'akcja', title: 'Historia projektu', desc: 'Ctrl+Shift+H', run: () => setUi({ modal: { kind: 'history', projectId: project.id } }) });
      out.push({ kind: 'akcja', title: 'Otwórz folder projektu', run: () => window.mc.openPath(project.path) });
      out.push({ kind: 'akcja', title: 'Otwórz projekt w Cursorze', run: () => window.mc.openInEditor(project.path) });
      if (tab) out.push({ kind: 'akcja', title: `Zamknij zakładkę „${tab.name}”`, desc: 'Ctrl+Shift+W', run: () => closeTab(project.id, tab.id) });
    }
    if (focused) {
      out.push({ kind: 'akcja', title: 'Maksymalizuj / przywróć komórkę', desc: 'Ctrl+Shift+M', run: () => toggleMaximize(focused) });
      out.push({ kind: 'akcja', title: 'Komórka: wznów rozmowę od nowa (restart)', run: () => restartCell(focused, 'resume') });
      out.push({ kind: 'akcja', title: 'Komórka: nowa rozmowa', run: () => restartCell(focused, 'new') });
    }
    out.push({ kind: 'akcja', title: 'Pokaż / ukryj snippety', desc: 'Ctrl+Shift+B', run: () => update((st) => ({ ...st, snippetsOpen: !st.snippetsOpen })) });
    out.push({ kind: 'akcja', title: 'Pokaż / ukryj panel projektów', desc: 'Ctrl+Shift+E', run: () => update((st) => ({ ...st, sidebarCollapsed: !st.sidebarCollapsed })) });
    out.push({ kind: 'akcja', title: 'Nowy snippet…', run: () => setUi({ modal: { kind: 'snippet', snippetId: null } }) });
    out.push({ kind: 'akcja', title: 'Ustawienia', run: () => setUi({ modal: { kind: 'settings' } }) });

    for (const p of s.projects) out.push({ kind: 'projekt', title: p.name, desc: p.path, run: () => switchProject(p.id) });
    for (const p of s.projects)
      for (const t of p.tabs)
        out.push({ kind: 'zakładka', title: t.name, desc: `${p.name} · ${describeLayout(t.layout)}`, run: () => { switchProject(p.id); selectTab(p.id, t); } });
    for (const sn of s.snippets.filter((x) => !x.projectId || x.projectId === project?.id))
      out.push({ kind: 'snippet', title: sn.name, desc: 'Enter: aktywna · Shift+Enter: wszystkie', run: (shift) => sendSnippet(sn, shift ? 'all' : 'focused') });
    if (project) {
      for (const pr of s.presets.filter((x) => !x.projectId || x.projectId === project.id))
        out.push({ kind: 'preset', title: pr.name, desc: describeLayout(pr.layout), run: () => void openTab(project.id, pr.layout, pr.cells) });
      for (const pf of s.profiles) {
        out.push({ kind: '+ agent', title: pf.name, desc: 'dodaj komórkę do siatki', run: () => void addAgent(pf.id) });
        out.push({ kind: 'terminal', title: pf.name, desc: 'nowa zakładka z jednym terminalem', run: () => quickTab(pf.id) });
      }
      for (const a of project.archive)
        out.push({ kind: 'historia', title: a.name, desc: `zamknięty grid ${describeLayout(a.layout)} — przywróć`, run: () => restoreArchived(project.id, a.id) });
      for (const x of sessions)
        out.push({ kind: x.cli, title: x.title, desc: 'wznów w nowej zakładce · Shift: w nowej komórce', run: (shift) => resumeSession(x, shift ? 'newCell' : 'newTab') });
    }
    return out;
  }, [s, sessions, project]);

  const results = fuzzyFilter(items, q, (i) => `${i.title} ${i.kind} ${i.desc ?? ''}`, 80);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (item: Item | undefined, shift: boolean) => {
    if (!item) return;
    close();
    item.run(shift);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal palette">
        <input
          autoFocus
          placeholder={`Szukaj projektów, zakładek, snippetów, rozmów, akcji…${getS().projects.length ? '' : ' (zacznij od „Nowy projekt”)'}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(results.length - 1, x + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(results[sel], e.shiftKey); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((item, i) => (
            <div key={i} className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseMove={() => setSel(i)} onClick={(e) => run(item, e.shiftKey)}>
              <span className="kind">{item.kind}</span>
              <span className="ptitle">{item.title}</span>
              {item.desc && <span className="pdesc">{item.desc}</span>}
            </div>
          ))}
          {!results.length && <div className="muted" style={{ padding: 12 }}>Nic nie znaleziono.</div>}
        </div>
      </div>
    </div>
  );
}
