import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { Project, ProjectDirectory, ProjectFileEntry } from '../../../shared/types';
import { setUi } from '../store';
import { openFile } from '../files';
import { openMenu } from './ContextMenu';
import { IChevron, ICollapse, IFile, IFolder, IRestart } from './icons';
import { ProjectIconView } from './ProjectIcon';
import { fullProjectPath as projectPath } from '../../../shared/platform';

export const fullProjectPath = (root: string, relative: string) =>
  projectPath(root, relative, window.mc.platform);

interface TreeProps {
  project: Project;
  path: string;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string, open?: boolean) => void;
  refresh: number;
}

function Directory({ project, path, depth, expanded, toggle, refresh }: TreeProps) {
  const { tr, errorText } = useI18n();
  const [listing, setListing] = useState<ProjectDirectory | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setListing(null);
    window.mc.listProjectDirectory(project.id, path)
      .then((result) => { if (!cancelled) setListing(result); })
      .catch(() => { if (!cancelled) setListing({ ok: false, error: 'Nie udało się wczytać folderu.' }); });
    return () => { cancelled = true; };
  }, [project.id, project.path, path, refresh, retry]);

  const fileMenu = (e: React.MouseEvent, entry: ProjectFileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    const fullPath = fullProjectPath(project.path, entry.path);
    openMenu(e.clientX, e.clientY, [
      { header: entry.name },
      entry.kind === 'directory'
        ? { label: expanded.has(entry.path) ? tr("Zwiń folder") : tr("Rozwiń folder"), onClick: () => toggle(entry.path) }
        : { label: tr("Podgląd pliku"), onClick: () => void openFile(project.id, entry.path) },
      { label: tr("Otwórz w edytorze"), onClick: () => window.mc.openInEditor(fullPath) },
      { label: tr("Pokaż w menedżerze plików"), onClick: () => window.mc.revealPath(fullPath) },
      { sep: true },
      { label: tr("Kopiuj ścieżkę"), onClick: () => window.mc.clipboardWrite(fullPath) },
      { label: tr("Kopiuj ścieżkę względną"), onClick: () => window.mc.clipboardWrite(entry.path) },
    ]);
  };

  if (!listing) return <div className="tree-message" style={{ paddingLeft: 12 + depth * 16 }}>{tr("Wczytywanie…")}</div>;
  if (!listing.ok) return (
    <div className="tree-message error" style={{ paddingLeft: 12 + depth * 16 }}>
      <span>{errorText(listing.error)}</span>
      <button className="btn small" onClick={() => setRetry((n) => n + 1)}>{tr("Spróbuj ponownie")}</button>
    </div>
  );
  if (!listing.entries.length) return <div className="tree-message" style={{ paddingLeft: 12 + depth * 16 }}>{tr("Pusty folder")}</div>;
  return (
    <ul className="file-tree" role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? tr('Pliki projektu {name}', { name: project.name }) : undefined}>
      {listing.entries.map((entry) => {
        const folder = entry.kind === 'directory';
        const open = expanded.has(entry.path);
        return (
          <li key={entry.path} role="none">
            <button
              className={`file-entry ${folder ? 'folder' : ''}`}
              role="treeitem"
              aria-expanded={folder ? open : undefined}
              title={entry.kind === 'symlink' ? `${entry.path} · link` : entry.path}
              style={{ paddingLeft: 10 + depth * 16 }}
              onClick={() => folder ? toggle(entry.path) : void openFile(project.id, entry.path)}
              onContextMenu={(e) => fileMenu(e, entry)}
              onKeyDown={(e) => {
                if (folder && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
                  e.preventDefault();
                  e.stopPropagation();
                  toggle(entry.path, e.key === 'ArrowRight');
                }
              }}
            >
              <span className={`tree-chevron ${open ? 'open' : ''}`}>{folder && <IChevron />}</span>
              {folder ? <IFolder /> : <IFile />}
              <span className="file-name">{entry.name}</span>
              {entry.kind === 'symlink' && <span className="muted">↗</span>}
            </button>
            {folder && open && <Directory project={project} path={entry.path} depth={depth + 1} expanded={expanded} toggle={toggle} refresh={refresh} />}
          </li>
        );
      })}
      {listing.truncated && <li className="tree-message" role="none">{tr("Wyświetlono pierwsze 2000 elementów. Pełna lista jest w menedżerze plików.")}</li>}
    </ul>
  );
}

export function ProjectExplorer({ project }: { project: Project }) {
  const { tr } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [refresh, setRefresh] = useState(0);
  const toggle = (path: string, open?: boolean) => setExpanded((previous) => {
    const next = new Set(previous);
    if (open ?? !next.has(path)) next.add(path);
    else next.delete(path);
    return next;
  });
  const menu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { header: project.name },
      { label: tr("Odśwież pliki"), onClick: () => setRefresh((n) => n + 1) },
      { label: tr("Zwiń wszystkie foldery"), onClick: () => setExpanded(new Set()) },
      { label: tr("Otwórz folder w menedżerze plików"), onClick: () => window.mc.openPath(project.path) },
      { label: tr("Otwórz projekt w edytorze"), onClick: () => window.mc.openInEditor(project.path) },
      { sep: true },
      { label: tr("Kopiuj ścieżkę projektu"), onClick: () => window.mc.clipboardWrite(project.path) },
      { label: tr("Wróć do projektów"), onClick: () => setUi({ sidebarView: 'projects' }) },
    ]);
  };
  return (
    <div className="project-explorer" onContextMenu={menu}>
      <div className="explorer-heading">
        <ProjectIconView project={project} />
        <span className="explorer-project" title={project.path}>{project.name}</span>
        <button className="btn ghost icon" title={tr("Zwiń wszystkie foldery")} aria-label={tr("Zwiń wszystkie foldery")} onClick={() => setExpanded(new Set())}><ICollapse /></button>
        <button className="btn ghost icon" title={tr("Odśwież pliki")} aria-label={tr("Odśwież pliki")} onClick={() => setRefresh((n) => n + 1)}><IRestart /></button>
      </div>
      <div className="explorer-tree">
        <Directory project={project} path="" depth={0} expanded={expanded} toggle={toggle} refresh={refresh} />
      </div>

    </div>
  );
}
