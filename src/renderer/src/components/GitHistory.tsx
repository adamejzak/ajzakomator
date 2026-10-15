import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatAgo } from '../../../shared/i18n';
import { GIT_LOG_PAGE, layoutGraph, type GitCommit, type GitCommitDetails, type GitRef } from '../../../shared/git';
import { useI18n } from '../i18n';
import { openDiffTab } from '../files';
import { baseName, chipRefs, dirName, letterOf } from '../../../shared/gitUi';
import { openMenu } from './ContextMenu';
import { GitGraph, graphLanes } from './GitGraph';
import { IBranch, IChevron, ICloud, ITag, IX } from './icons';

/** Loaded rows stop here: the list stays light, a filter or the search finds older commits. */
const MAX_LOADED = 3000;

/** `historyKey` changes when HEAD or the branches moved (the list then starts again); `initial`: the repository has no commit yet. */
interface Props { projectId: string; historyKey: string; initial: boolean; opts: { worktree?: string }; nonce: number; collapsed?: boolean; onToggle?(): void; height?: number | null }

/** The History section: commits in pages of 50 (loaded while scrolling), a thin graph, filters, and the details of one commit. */
export function GitHistory({ projectId, historyKey, initial, opts, nonce, collapsed = false, onToggle, height = null }: Props) {
  const { tr, language, errorText } = useI18n();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<GitCommit | null>(null);
  const sequence = useRef(0);
  const loadingMore = useRef(false);
  const worktree = opts.worktree;

  // The first page again whenever HEAD moved, an operation finished or the filter changed.
  const key = `${historyKey}:${nonce}:${query}:${all}:${worktree ?? ''}`;
  useEffect(() => {
    const mine = ++sequence.current;
    loadingMore.current = false;
    setLoading(true);
    window.mc.git.log(projectId, { skip: 0, count: GIT_LOG_PAGE, ...(query ? { search: query } : {}), ...(all ? { all: true } : {}), ...(worktree ? { worktree } : {}) })
      .then((r) => {
        if (mine !== sequence.current) return;
        if (r.ok) { setCommits(r.data.commits); setHasMore(r.data.hasMore); setError(null); }
        else { setError(r.error); setCommits([]); setHasMore(false); }
      })
      .catch((e) => { if (mine === sequence.current) setError(String(e)); })
      .finally(() => { if (mine === sequence.current) setLoading(false); });
  }, [key, projectId, query, all, worktree]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadMore = useCallback(() => {
    if (loadingMore.current || !hasMore || commits.length >= MAX_LOADED) return;
    loadingMore.current = true;
    const mine = sequence.current;
    window.mc.git.log(projectId, { skip: commits.length, count: GIT_LOG_PAGE, ...(query ? { search: query } : {}), ...(all ? { all: true } : {}), ...(worktree ? { worktree } : {}) })
      .then((r) => {
        if (mine !== sequence.current) return;
        if (r.ok) { setCommits((prev) => [...prev, ...r.data.commits]); setHasMore(r.data.hasMore); }
        else setError(r.error);
      })
      .catch((e) => setError(String(e)))
      .finally(() => { loadingMore.current = false; });
  }, [projectId, commits.length, hasMore, query, all, worktree]);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = useMemo(() => graphLanes(rows), [rows]);
  // Filters hide commits, so the graph of a filtered list would show lanes that do not connect: only the full history draws it.
  const graph = !query;

  if (selected) return <GitCommitView projectId={projectId} commit={selected} opts={opts} onBack={() => setSelected(null)} />;

  return (
    <section className={`git-history ${collapsed ? 'collapsed' : ''}`} aria-label={tr('Historia')} style={!collapsed && height ? { flex: `0 0 ${height}px` } : undefined}>
      <div className="git-section-head static">
        {onToggle
          ? <button className="git-toggle" aria-expanded={!collapsed} onClick={onToggle} title={collapsed ? tr('Rozwiń historię') : tr('Zwiń historię')}><span className={`tree-chevron ${collapsed ? '' : 'open'}`}><IChevron /></span><span>{tr('Historia')}</span></button>
          : <span>{tr('Historia')}</span>}
        <span className="git-spacer" />
        {!collapsed && <button className={`btn ghost icon small ${all ? 'on' : ''}`} aria-pressed={all} title={tr('Pokaż commity wszystkich gałęzi')} aria-label={tr('Pokaż commity wszystkich gałęzi')} onClick={() => setAll((v) => !v)}>
          <IBranch />
        </button>}
      </div>
      {!collapsed && <>
      <div className="git-search">
        <input className="input" value={search} placeholder={tr('Szukaj w opisach commitów…')} aria-label={tr('Szukaj w opisach commitów…')} onChange={(e) => setSearch(e.target.value)} />
        {search && <button className="btn ghost icon small" aria-label={tr('Wyczyść')} title={tr('Wyczyść')} onClick={() => setSearch('')}><IX /></button>}
      </div>
      <div
        className="git-log"
        onScroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) loadMore(); }}
      >
        {error && <p className="git-note error">{errorText(error)}</p>}
        {!error && !loading && !commits.length && <p className="git-note muted">{initial ? tr('Repozytorium nie ma jeszcze commitów.') : tr('Brak commitów.')}</p>}
        {commits.map((commit, i) => {
          const { shown, more } = chipRefs(commit.refs);
          return (
            <div
              key={commit.hash}
              className="git-commit"
              role="button"
              tabIndex={0}
              title={`${commit.subject}\n${commit.short} · ${commit.author} · ${formatAgo(language, commit.at * 1000)}`}
              onClick={() => setSelected(commit)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSelected(commit); }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, [
                  { label: tr('Pokaż szczegóły'), onClick: () => setSelected(commit) },
                  { label: tr('Kopiuj hash'), onClick: () => window.mc.clipboardWrite(commit.hash) },
                ]);
              }}
            >
              {graph && rows[i] && <GitGraph row={rows[i]} lanes={lanes} />}
              <div className="git-commit-text">
                <div className="git-commit-subject">
                  <span className="git-subject-text">{commit.subject}</span>
                  <span className="git-chips">
                    {shown.map((ref) => <RefChip key={`${ref.kind}:${ref.name}`} gitRef={ref} />)}
                    {more > 0 && <span className="git-chip more" title={tr('Pokaż commity wszystkich gałęzi')}>+{more}</span>}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {loading && <p className="git-note muted">{tr('Wczytywanie…')}</p>}
        {!loading && hasMore && <button className="btn small git-more" onClick={loadMore}>{tr('Wczytaj więcej')}</button>}
      </div>
      </>}
    </section>
  );
}

/** A branch or tag of a commit: local branches and tags show their name, remote ones only a cloud (the name is in the tooltip). */
function RefChip({ gitRef }: { gitRef: GitRef }) {
  const remote = gitRef.kind === 'remote';
  return (
    <span className={`git-chip ${gitRef.kind} ${gitRef.current ? 'current' : ''} ${remote ? 'icon-only' : ''}`} title={gitRef.name}>
      {remote ? <ICloud /> : gitRef.kind === 'tag' ? <ITag /> : <IBranch />}
      {!remote && <span className="git-chip-name">{gitRef.name}</span>}
    </span>
  );
}

/** One commit: message, stats and its files (a click on a file opens the diff). */
function GitCommitView({ projectId, commit, opts, onBack }: { projectId: string; commit: GitCommit; opts: { worktree?: string }; onBack(): void }) {
  const { tr, language, errorText } = useI18n();
  const [details, setDetails] = useState<GitCommitDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const worktree = opts.worktree;

  useEffect(() => {
    let cancelled = false;
    window.mc.git.show(projectId, { hash: commit.hash, ...(worktree ? { worktree } : {}) })
      .then((r) => { if (cancelled) return; if (r.ok) setDetails(r.data); else setError(r.error); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, commit.hash, worktree]);

  const { shown } = chipRefs(commit.refs, 8);
  return (
    <section className="git-history git-details" aria-label={tr('Szczegóły commita')}>
      <button className="git-back" onClick={onBack}><span className="git-back-chevron"><IChevron /></span>{tr('Historia')}</button>
      <div className="git-details-body">
        <div className="git-details-subject">{commit.subject}</div>
        <div className="git-commit-meta muted" title={commit.hash}>{commit.short} · {commit.author} · {formatAgo(language, commit.at * 1000)}</div>
        {shown.length > 0 && <div className="git-details-chips">{shown.map((ref) => <RefChip key={`${ref.kind}:${ref.name}`} gitRef={ref} />)}</div>}
        {error && <p className="git-note error">{errorText(error)}</p>}
        {!details && !error && <p className="git-note muted">{tr('Wczytywanie…')}</p>}
        {details && (
          <>
            {details.message.includes('\n') && <pre className="git-message">{details.message.split('\n').slice(1).join('\n').trim()}</pre>}
            <div className="git-stats muted">
              {tr('Pliki: {count}', { count: details.files.length + (details.filesTruncated ? 1 : 0) })}{details.filesTruncated ? '+' : ''}
              {' · '}<span className="plus">+{details.added}</span> <span className="minus">-{details.deleted}</span>
            </div>
            <div className="git-files">
              {details.files.map((file) => {
                const letter = letterOf(file.status);
                return (
                  <div
                    key={`${file.status}:${file.path}`}
                    className="git-file"
                    role="button"
                    tabIndex={0}
                    title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                    onClick={() => openDiffTab(projectId, { source: 'commit', hash: commit.hash, path: file.path, ...(file.origPath ? { oldPath: file.origPath } : {}), ...(worktree ? { worktree } : {}) })}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLElement).click(); }}
                  >
                    <span className={`git-letter ${letter.cls}`} title={tr(letter.title)}>{letter.letter}</span>
                    <span className="git-file-name">{baseName(file.path)}<span className="git-file-dir">{dirName(file.path)}</span></span>
                    <span className="git-file-stat muted">{file.added === null ? 'bin' : <><span className="plus">+{file.added}</span> <span className="minus">-{file.deleted}</span></>}</span>
                  </div>
                );
              })}
              {details.filesTruncated && <p className="git-note muted">{tr('Pokazano pierwsze {count} plików.', { count: details.files.length })}</p>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
