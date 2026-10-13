import { useI18n } from '../i18n';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Project, ProjectDirectory, ProjectFileEntry } from '../../../shared/types';
import { setUi, toast } from '../store';
import { openFile, treeOpen } from '../files';
import { openMenu } from './ContextMenu';
import { IChevron, ICollapseAll, IExpandAll, IFile, IFolder, ISearch } from './icons';
import { RefreshIcon, useHoldBusy } from './Spinner';
import { ProjectIconView } from './ProjectIcon';
import { fullProjectPath as projectPath } from '../../../shared/platform';
import { baseName, parentPath, renameSelectionEnd, summarizeNames, topLevelPaths, validateEntryName } from '../../../shared/fileOps';
import { keyLabel } from '../platform';
import { buildPathPayload, PATH_MIME } from '../../../shared/pathDrop';
import { addTreePathsToFocusedCell, focusedCellId } from '../pathDrop';
import {
  bumpRefresh, cancelBusy, copyToClipboard, createEntry, duplicateEntries, expandedSet, kindOf, pasteInto, rememberKinds, renameEntry,
  selectPaths, selectedPaths, setExpanded, targetDirectory, toggleFolder, transferEntries, trashEntries, undoLast, useExplorer,
} from '../explorer';

export const fullProjectPath = (root: string, relative: string) =>
  projectPath(root, relative, window.mc.platform);

const TREE_MIME = 'application/x-mc-tree-entries';
/** What is being dragged inside the tree (dataTransfer content is not readable while dragging over). */
let dragging: { projectId: string; paths: string[] } | null = null;

interface TreeContext {
  project: Project;
  expanded: Set<string>;
  selected: Set<string>;
  cut: Set<string>;
  renaming: string | null;
  dropTarget: string | null;
  refresh: number;
  click(e: React.MouseEvent, entry: ProjectFileEntry): void;
  menu(e: React.MouseEvent, entry: ProjectFileEntry): void;
  dragStart(e: React.DragEvent, entry: ProjectFileEntry): void;
  dragOver(e: React.DragEvent, entry: ProjectFileEntry): void;
  drop(e: React.DragEvent, dir: string): void;
  dragEnd(): void;
  startRename(path: string): void;
  stopRename(): void;
}
const Tree = createContext<TreeContext>(null as unknown as TreeContext);

function RenameRow({ entry, depth }: { entry: ProjectFileEntry; depth: number }) {
  const { tr } = useI18n();
  const tree = useContext(Tree);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const folder = entry.kind === 'directory';
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.setSelectionRange(0, renameSelectionEnd(entry.name, folder));
  }, []);
  const cancel = () => { finished.current = true; tree.stopRename(); };
  const commit = async (fromBlur: boolean) => {
    if (finished.current) return;
    const name = (input.current?.value ?? '').trim();
    if (name === entry.name) { cancel(); return; }
    const invalid = validateEntryName(name, window.mc.platform);
    if (invalid) {
      if (fromBlur) { cancel(); return; }
      setError(tr(invalid as Parameters<typeof tr>[0])); return;
    }
    finished.current = true;
    const done = await renameEntry(tree.project.id, entry.path, name);
    if (done) tree.stopRename();
    else if (fromBlur) tree.stopRename();
    else { finished.current = false; input.current?.focus(); }
  };
  return (
    <div className="file-entry editing" style={{ paddingLeft: 10 + depth * 16 }} role="treeitem" aria-selected>
      <span className="tree-chevron">{folder && <IChevron />}</span>
      {folder ? <IFolder /> : <IFile />}
      <input
        ref={input} className="file-rename" defaultValue={entry.name} aria-label={tr('Nowa nazwa')} aria-invalid={error ? true : undefined} title={error ?? undefined} spellCheck={false}
        onChange={() => setError(null)}
        onBlur={() => void commit(true)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); void commit(false); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
      />
      {error && <span className="file-rename-error" role="alert">{error}</span>}
    </div>
  );
}

interface DirectoryProps { path: string; depth: number }

function Directory({ path, depth }: DirectoryProps) {
  const { tr, errorText } = useI18n();
  const tree = useContext(Tree);
  const { project, expanded, refresh } = tree;
  const [listing, setListing] = useState<ProjectDirectory | null>(null);
  const [retry, setRetry] = useState(0);
  const loadedKey = useRef('');
  useEffect(() => {
    let cancelled = false;
    // A reload keeps the previous listing on screen (no flicker, expansion and scroll stay); a new folder starts empty.
    const key = `${project.id}|${project.path}|${path}`;
    if (loadedKey.current !== key) { setListing(null); loadedKey.current = key; }
    window.mc.listProjectDirectory(project.id, path)
      .then((result) => { if (!cancelled) { if (result.ok) rememberKinds(project.id, result.entries); setListing(result); } })
      .catch(() => { if (!cancelled) setListing({ ok: false, error: 'Nie udało się wczytać folderu.' }); });
    return () => { cancelled = true; };
  }, [project.id, project.path, path, refresh, retry]);

  if (!listing) return <div className="tree-message" style={{ paddingLeft: 12 + depth * 16 }}>{tr("Wczytywanie…")}</div>;
  if (!listing.ok) return (
    <div className="tree-message error" style={{ paddingLeft: 12 + depth * 16 }}>
      <span>{errorText(listing.error)}</span>
      <button className="btn small" onClick={() => setRetry((n) => n + 1)}>{tr("Spróbuj ponownie")}</button>
    </div>
  );
  if (!listing.entries.length) return <div className="tree-message" style={{ paddingLeft: 12 + depth * 16 }}>{tr("Pusty folder")}</div>;
  return (
    <ul className="file-tree" role={depth === 0 ? 'tree' : 'group'} aria-multiselectable={depth === 0 ? true : undefined} aria-label={depth === 0 ? tr('Pliki projektu {name}', { name: project.name }) : undefined}>
      {listing.entries.map((entry) => {
        const folder = entry.kind === 'directory';
        const open = expanded.has(entry.path);
        const selected = tree.selected.has(entry.path);
        return (
          <li key={entry.path} role="none">
            {tree.renaming === entry.path ? <RenameRow entry={entry} depth={depth} /> : (
              <button
                className={`file-entry ${folder ? 'folder' : ''} ${selected ? 'selected' : ''} ${tree.cut.has(entry.path) ? 'cut' : ''} ${tree.dropTarget === entry.path ? 'drop-target' : ''}`}
                role="treeitem"
                aria-expanded={folder ? open : undefined}
                aria-selected={selected}
                data-path={entry.path}
                data-kind={entry.kind}
                title={entry.kind === 'symlink' ? `${entry.path} · link` : entry.path}
                style={{ paddingLeft: 10 + depth * 16 }}
                draggable
                onClick={(e) => tree.click(e, entry)}
                onDoubleClick={(e) => { e.preventDefault(); tree.startRename(entry.path); }}
                onContextMenu={(e) => tree.menu(e, entry)}
                onDragStart={(e) => tree.dragStart(e, entry)}
                onDragOver={(e) => tree.dragOver(e, entry)}
                onDrop={(e) => tree.drop(e, folder ? entry.path : parentPath(entry.path))}
                onDragEnd={tree.dragEnd}
                onKeyDown={(e) => {
                  if (folder && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleFolder(project.id, entry.path, e.key === 'ArrowRight');
                  }
                }}
              >
                <span className={`tree-chevron ${open ? 'open' : ''}`}>{folder && <IChevron />}</span>
                {folder ? <IFolder /> : <IFile />}
                <span className="file-name">{entry.name}</span>
                {entry.kind === 'symlink' && <span className="muted">↗</span>}
              </button>
            )}
            {folder && open && <Directory path={entry.path} depth={depth + 1} />}
          </li>
        );
      })}
      {listing.truncated && <li className="tree-message" role="none">{tr("Wyświetlono pierwsze 2000 elementów. Pełna lista jest w menedżerze plików.")}</li>}
    </ul>
  );
}

export function ProjectExplorer({ project }: { project: Project }) {
  const { tr } = useI18n();
  const expandedPaths = useExplorer((s) => s.expanded[project.id]);
  const selection = useExplorer((s) => s.selection[project.id]);
  const clipboard = useExplorer((s) => s.clipboard);
  const renaming = useExplorer((s) => s.renaming?.projectId === project.id ? s.renaming.path : null);
  const reveal = useExplorer((s) => s.reveal);
  const refresh = useExplorer((s) => s.refresh);
  const busy = useExplorer((s) => s.busy);
  const [manualRefresh, setManualRefresh] = useState(false);
  const spinning = useHoldBusy(manualRefresh, 700);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hover = useRef<{ path: string; timer: number } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const expanded = new Set(expandedPaths ?? []);
  const selected = new Set(selection?.paths ?? []);
  const cut = new Set(clipboard && clipboard.mode === 'cut' && clipboard.projectId === project.id ? clipboard.paths : []);

  const reload = () => { bumpRefresh(); setManualRefresh(true); setTimeout(() => setManualRefresh(false), 50); };
  const expandAll = async () => {
    try {
      const result = await window.mc.listProjectDirectories(project.id);
      if (!result.ok) { toast(result.error, 'error'); return; }
      setExpanded(project.id, result.paths);
      if (result.truncated) toast(tr('Rozwinięto pierwsze {count} folderów.', { count: result.paths.length }));
    } catch (error) { toast(String(error), 'error'); }
  };
  const anyOpen = expanded.size > 0;
  const toggleAll = () => (anyOpen ? setExpanded(project.id, []) : void expandAll());
  const toggleAllLabel = anyOpen ? tr("Zwiń wszystkie foldery") : tr("Rozwiń wszystkie foldery");
  const findInFiles = () => setUi({ modal: { kind: 'search', projectId: project.id } });

  const visiblePaths = () => Array.from(treeRef.current?.querySelectorAll<HTMLElement>('.file-entry[data-path]') ?? []).map((el) => el.dataset.path!);
  const startRename = (path: string) => useExplorer.setState({ renaming: { projectId: project.id, path } });
  const stopRename = () => useExplorer.setState({ renaming: null });
  const clearHover = () => { if (hover.current) window.clearTimeout(hover.current.timer); hover.current = null; };
  const endDrag = () => { dragging = null; setDropTarget(null); clearHover(); };

  // "Locate in Files": the folders are expanded already; wait for their listings, then scroll the item into view.
  useEffect(() => {
    if (!reveal || reveal.projectId !== project.id) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('.file-entry[data-path]') ?? []).find((item) => item.dataset.path === reveal.path);
      if (el) { window.clearInterval(timer); el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); }
      else if (++tries > 60) window.clearInterval(timer);
    }, 50);
    return () => window.clearInterval(timer);
  }, [reveal?.nonce, project.id]);
  useEffect(() => () => { clearHover(); }, []);

  const canDrop = (paths: string[], dir: string, copy: boolean) =>
    paths.every((p) => dir !== p && !dir.startsWith(`${p}/`)) && (copy || paths.some((p) => parentPath(p) !== dir));
  const isCopy = (e: React.DragEvent | React.KeyboardEvent) => e.ctrlKey || (window.mc.platform === 'darwin' && e.altKey);

  const commandTargets = (): string[] => {
    const current = selectedPaths(project.id);
    if (current.length) return current;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.path;
    return focused ? [focused] : [];
  };

  const context: TreeContext = {
    project, expanded, selected, cut, renaming, dropTarget, refresh,
    startRename, stopRename, dragEnd: endDrag,
    click: (e, entry) => {
      const folder = entry.kind === 'directory';
      if (e.shiftKey) {
        const list = visiblePaths();
        const anchor = selection?.anchor ?? entry.path;
        const a = list.indexOf(anchor), b = list.indexOf(entry.path);
        if (a >= 0 && b >= 0) selectPaths(project.id, list.slice(Math.min(a, b), Math.max(a, b) + 1), anchor);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const next = selected.has(entry.path) ? [...selected].filter((p) => p !== entry.path) : [...selected, entry.path];
        selectPaths(project.id, next, entry.path);
        return;
      }
      selectPaths(project.id, [entry.path], entry.path);
      if (folder) toggleFolder(project.id, entry.path);
      else { treeOpen.keyboard = e.detail === 0; void openFile(project.id, entry.path); }
    },
    menu: (e, entry) => {
      e.preventDefault();
      e.stopPropagation();
      const targets = selected.has(entry.path) ? selectedPaths(project.id) : [entry.path];
      if (!selected.has(entry.path)) selectPaths(project.id, [entry.path], entry.path);
      const fullPath = fullProjectPath(project.path, entry.path);
      const folder = entry.kind === 'directory';
      const dir = folder ? entry.path : parentPath(entry.path);
      const multi = targets.length > 1;
      const { shown, more } = summarizeNames(targets.map(baseName), 3);
      const canPaste = !!clipboard && clipboard.projectId === project.id;
      openMenu(e.clientX, e.clientY, [
        { header: multi ? shown.join(', ') + (more ? ` +${more}` : '') : entry.name },
        ...(multi ? [] : [
          folder
            ? { label: expanded.has(entry.path) ? tr("Zwiń folder") : tr("Rozwiń folder"), onClick: () => toggleFolder(project.id, entry.path) }
            : { label: tr("Podgląd pliku"), onClick: () => void openFile(project.id, entry.path) },
          { label: tr("Otwórz w edytorze"), onClick: () => window.mc.openInEditor(fullPath) },
          { label: tr("Pokaż w menedżerze plików"), onClick: () => window.mc.revealPath(fullPath) },
          { sep: true as const },
          { label: tr("Nowy plik") + '…', onClick: () => void createEntry(project.id, dir, 'file') },
          { label: tr("Nowy folder") + '…', onClick: () => void createEntry(project.id, dir, 'directory') },
        ]),
        { sep: true },
        ...(multi ? [] : [{ label: tr("Zmień nazwę"), hint: 'F2', onClick: () => startRename(entry.path) }]),
        { label: tr("Dodaj do rozmowy"), disabled: !focusedCellId(), onClick: () => addTreePathsToFocusedCell(project.id, targets) },
        { label: tr("Duplikuj"), onClick: () => void duplicateEntries(project.id, targets) },
        { label: tr("Wytnij"), hint: keyLabel('Ctrl+X'), onClick: () => copyToClipboard(project.id, targets, 'cut') },
        { label: tr("Kopiuj"), hint: keyLabel('Ctrl+C'), onClick: () => copyToClipboard(project.id, targets, 'copy') },
        { label: tr("Wklej"), hint: keyLabel('Ctrl+V'), disabled: !canPaste || multi, onClick: () => void pasteInto(project.id, dir) },
        ...(multi ? [] : [
          { sep: true as const },
          { label: tr("Kopiuj ścieżkę"), onClick: () => window.mc.clipboardWrite(fullPath) },
          { label: tr("Kopiuj ścieżkę względną"), onClick: () => window.mc.clipboardWrite(entry.path) },
        ]),
        { sep: true },
        { label: tr("Przenieś do kosza"), danger: true, hint: 'Del', onClick: () => void trashEntries(project.id, targets) },
      ]);
    },
    dragStart: (e, entry) => {
      const paths = topLevelPaths(selected.has(entry.path) ? [...selected] : [entry.path]);
      if (!selected.has(entry.path)) selectPaths(project.id, [entry.path], entry.path);
      dragging = { projectId: project.id, paths };
      e.dataTransfer.setData(TREE_MIME, JSON.stringify(dragging));
      e.dataTransfer.setData('text/plain', paths.map((p) => fullProjectPath(project.path, p)).join('\n'));
      // For cells: identifiers only, the receiver rebuilds and checks the paths (see shared/pathDrop.ts).
      e.dataTransfer.setData(PATH_MIME, buildPathPayload(project.id, project.path, paths.map((p) => ({ relPath: p, kind: kindOf(project.id, p) })), window.mc.platform));
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    dragOver: (e, entry) => {
      if (!dragging || dragging.projectId !== project.id) return;
      e.stopPropagation();
      const folder = entry.kind === 'directory';
      const dir = folder ? entry.path : parentPath(entry.path);
      const copy = isCopy(e);
      if (!canDrop(dragging.paths, dir, copy)) { setDropTarget(null); clearHover(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
      setDropTarget(dir);
      if (folder && !expanded.has(entry.path)) {
        if (hover.current?.path !== entry.path) {
          clearHover();
          hover.current = { path: entry.path, timer: window.setTimeout(() => { toggleFolder(project.id, entry.path, true); hover.current = null; }, 600) };
        }
      } else clearHover();
    },
    drop: (e, dir) => {
      if (!dragging || dragging.projectId !== project.id) return;
      e.preventDefault();
      e.stopPropagation();
      const dropped = dragging;
      const copy = isCopy(e);
      endDrag();
      if (!canDrop(dropped.paths, dir, copy)) return;
      void transferEntries({ projectId: project.id, kind: copy ? 'copy' : 'move', paths: dropped.paths, destination: dir });
    },
  };

  const onTreeKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    const targets = commandTargets();
    if (e.key === 'F2' && targets.length === 1) { e.preventDefault(); startRename(targets[0]); }
    else if (e.key === 'Delete' && targets.length) { e.preventDefault(); void trashEntries(project.id, targets); }
    else if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyC' && targets.length) { e.preventDefault(); copyToClipboard(project.id, targets, 'copy'); }
    else if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyX' && targets.length) { e.preventDefault(); copyToClipboard(project.id, targets, 'cut'); }
    else if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); void pasteInto(project.id, targetDirectory(project.id)); }
    else if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyZ') { e.preventDefault(); void undoLast(project.id); }
    else if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyA') { e.preventDefault(); selectPaths(project.id, visiblePaths()); }
    else if (!mod && !e.altKey && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const list = visiblePaths();
      if (!list.length) return;
      const focused = (document.activeElement as HTMLElement | null)?.dataset?.path;
      const index = focused ? list.indexOf(focused) : -1;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
        : Math.min(list.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();
      const path = list[next];
      Array.from(treeRef.current?.querySelectorAll<HTMLElement>('.file-entry[data-path]') ?? []).find((el) => el.dataset.path === path)?.focus();
      if (e.shiftKey) {
        const anchor = selection?.anchor ?? list[Math.max(0, index)];
        const a = list.indexOf(anchor);
        selectPaths(project.id, list.slice(Math.min(a, next), Math.max(a, next) + 1), anchor);
      } else selectPaths(project.id, [path], path);
    }
  };

  const menu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { header: project.name },
      { label: tr("Nowy plik") + '…', onClick: () => void createEntry(project.id, '', 'file') },
      { label: tr("Nowy folder") + '…', onClick: () => void createEntry(project.id, '', 'directory') },
      { label: tr("Wklej"), hint: keyLabel('Ctrl+V'), disabled: !clipboard || clipboard.projectId !== project.id, onClick: () => void pasteInto(project.id, '') },
      { sep: true },
      { label: tr("Odśwież pliki"), onClick: reload },
      { label: tr("Znajdź i zamień w plikach…"), onClick: findInFiles },
      { label: toggleAllLabel, onClick: toggleAll },
      { label: tr("Otwórz folder w menedżerze plików"), onClick: () => window.mc.openPath(project.path) },
      { label: tr("Otwórz projekt w edytorze"), onClick: () => window.mc.openInEditor(project.path) },
      { sep: true },
      { label: tr("Kopiuj ścieżkę projektu"), onClick: () => window.mc.clipboardWrite(project.path) },
      { label: tr("Wróć do projektów"), onClick: () => setUi({ sidebarView: 'projects' }) },
    ]);
  };
  return (
    <div className="project-explorer" onContextMenu={menu} onKeyDown={onTreeKey}>
      <div className="explorer-heading">
        <ProjectIconView project={project} />
        <span className="explorer-project" title={project.path}>{project.name}</span>
        <button className="btn ghost icon" title={tr("Nowy plik")} aria-label={tr("Nowy plik")} onClick={() => void createEntry(project.id, targetDirectory(project.id), 'file')}><IFile /></button>
        <button className="btn ghost icon" title={tr("Nowy folder")} aria-label={tr("Nowy folder")} onClick={() => void createEntry(project.id, targetDirectory(project.id), 'directory')}><IFolder /></button>
        <button className="btn ghost icon" title={tr("Znajdź i zamień w plikach…")} aria-label={tr("Znajdź i zamień w plikach…")} onClick={findInFiles}><ISearch /></button>
        <button className="btn ghost icon" title={toggleAllLabel} aria-label={toggleAllLabel} onClick={toggleAll}>{anyOpen ? <ICollapseAll /> : <IExpandAll />}</button>
        <button className="btn ghost icon" title={tr("Odśwież pliki")} aria-label={tr("Odśwież pliki")} onClick={reload}><RefreshIcon spinning={spinning} /></button>
      </div>
      <Tree.Provider value={context}>
        <div
          ref={treeRef}
          className={`explorer-tree ${dropTarget === '' ? 'drop-root' : ''}`}
          onDragOver={(e) => {
            if (!dragging || dragging.projectId !== project.id) return;
            const copy = isCopy(e);
            if (!canDrop(dragging.paths, '', copy)) { setDropTarget(null); return; }
            e.preventDefault();
            e.dataTransfer.dropEffect = copy ? 'copy' : 'move';
            setDropTarget('');
            clearHover();
          }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDropTarget(null); clearHover(); } }}
          onDrop={(e) => context.drop(e, '')}
        >
          <Directory path="" depth={0} />
        </div>
      </Tree.Provider>
      {busy && (
        <div className="explorer-busy" role="status">
          <span>{tr('Kopiowanie… ({count})', { count: busy.entries })}</span>
          <button className="btn small" onClick={cancelBusy}>{tr('Anuluj')}</button>
        </div>
      )}
    </div>
  );
}
