// The Git panel of the left rail: the state of the active project's repository (branch, changes) and its history, with the
// everyday actions (fetch, pull --ff-only, push with confirmation, stage, commit, switch branch). Nothing destructive lives here.
import { useCallback, useEffect, useState } from 'react';
import { activeProject, findCell } from '../../../shared/state';
import { normalizeProjectPath } from '../../../shared/platform';
import { projectRelativePath, type GitBranch, type GitFileChange, type GitOpResult, type GitResult, type GitWorktree } from '../../../shared/git';
import { useI18n } from '../i18n';
import { askChoice, setUi, toast, useStore } from '../store';
import { openFile } from '../files';
import { locateInFiles } from '../explorer';
import { useGitProbe } from '../git/gitProbe';
import { newRequestId } from '../../../shared/gitUi';
import { useGitRepo } from '../git/useGitRepo';
import { openMenu, openMenuAt } from './ContextMenu';
import { GitChanges } from './GitChanges';
import { GitHistory } from './GitHistory';
import { IBranch, IChevron, IRestart } from './icons';
import './gitPanel.css';

const same = (a: string, b: string): boolean => normalizeProjectPath(a) === normalizeProjectPath(b);

export function GitPanel() {
  const { tr } = useI18n();
  const project = useStore((st) => activeProject(st.s));
  const probe = useGitProbe(project?.id);
  if (!project) return <div className="sidebar-content git-panel"><p className="git-note">{tr('Najpierw dodaj projekt')}</p></div>;
  if (probe === 'no-repo') return <div className="sidebar-content git-panel"><p className="git-note">{tr('To nie jest repozytorium git')}</p></div>;
  if (probe === 'no-git') return <div className="sidebar-content git-panel"><p className="git-note">{tr('Nie znaleziono polecenia git. Zainstaluj Git (git-scm.com) i uruchom aplikację ponownie.')}</p></div>;
  return <RepoView key={`${project.id}:${project.path}`} projectId={project.id} projectPath={project.path} />;
}

function RepoView({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const { tr, errorText } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const cellWorktree = useStore((st) => { const id = st.ui.focusedCellId; return id ? findCell(st.s, id)?.cell.worktree?.path : undefined; });

  // The worktree to show: the one the user picked, else the one of the focused cell, else the project folder itself.
  const wanted = picked ?? cellWorktree ?? null;
  const known = wanted ? worktrees.find((w) => same(w.path, wanted)) : undefined;
  const worktree = known && !same(known.path, projectPath) ? known.path : undefined;
  const repo = useGitRepo(projectId, worktree);
  const { status } = repo;

  useEffect(() => {
    let cancelled = false;
    window.mc.git.worktrees(projectId).then((r) => { if (!cancelled && r.ok) setWorktrees(r.data); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, cellWorktree, status?.branch, status?.head]);

  const opts = worktree ? { worktree } : {};

  /** Runs one user-initiated operation: one at a time, with its result (or git's own message) as a toast, then a refresh. */
  const run = useCallback(async (action: string, call: () => Promise<GitResult<GitOpResult>>, quiet = false): Promise<boolean> => {
    if (busy) return false;
    setBusy(action);
    let done = false;
    try {
      const result = await call();
      if (result.ok) { if (!quiet) toast(`${action}: ${result.data.message}`); done = true; }
      else toast(tr('Git: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) {
      toast(tr('Git: {error}', { error: String(e) }), 'error');
    } finally {
      setBusy(null);
      setNonce((n) => n + 1);
      repo.refresh(0);
    }
    return done;
  }, [busy, tr, errorText, repo]);

  const hasLocalChanges = !!status?.files.some((f) => !f.untracked);

  const fetchNow = () => void run('Fetch', () => window.mc.git.fetch(projectId, { requestId: newRequestId(), ...opts }));
  const pullNow = () => void run('Pull', () => window.mc.git.pull(projectId, { requestId: newRequestId(), ...opts }));
  const pushNow = async () => {
    const push = status?.push;
    if (!status || !push) { toast(tr('Brak zdalnego repozytorium, do którego można wypchnąć tę gałąź.'), 'error'); return; }
    const lines = [tr('Gałąź {branch} zostanie wysłana do {target}.', { branch: status.branch ?? '', target: `${push.remote}/${push.branch}` })];
    if (status.ahead) lines.push(tr('Commitów do wysłania: {count}', { count: status.ahead }));
    if (push.setUpstream) lines.push(tr('Ustawione zostanie też śledzenie gałęzi zdalnej.'));
    const choice = await askChoice(tr('Wypchnąć zmiany?'), lines.join('\n'), [{ label: 'Push', value: 'push', primary: true }]);
    if (choice !== 'push') return;
    void run('Push', () => window.mc.git.push(projectId, { requestId: newRequestId(), remote: push.remote, branch: push.branch, ...opts }));
  };

  const switchBranch = async (branch: GitBranch) => {
    if (hasLocalChanges) { toast(tr('Masz niezatwierdzone zmiany. Zatwierdź je lub odłóż, zanim zmienisz gałąź.'), 'error'); return; }
    const choice = await askChoice(tr('Przełączyć na gałąź „{branch}”?', { branch: branch.name }), tr('Zmieni się zawartość plików w folderze projektu.'), [{ label: tr('Przełącz'), value: 'go', primary: true }]);
    if (choice !== 'go') return;
    void run(tr('Gałąź'), () => window.mc.git.checkout(projectId, { requestId: newRequestId(), branch: branch.name, ...(branch.remote ? { remote: true } : {}), ...opts }));
  };

  const openBranches = async (button: HTMLElement) => {
    const result = await window.mc.git.branches(projectId, opts);
    if (!result.ok) { toast(tr('Git: {error}', { error: errorText(result.error) }), 'error'); return; }
    const local = result.data.filter((b) => !b.remote).slice(0, 60);
    const remote = result.data.filter((b) => b.remote).slice(0, 40);
    openMenuAt(button, [
      { header: tr('Gałęzie') },
      ...local.map((b) => ({ label: b.name, hint: b.current ? tr('bieżąca') : b.track || undefined, disabled: b.current, onClick: () => void switchBranch(b) })),
      ...(remote.length ? [{ sep: true as const }, { header: tr('Zdalne') }, ...remote.map((b) => ({ label: b.name, onClick: () => void switchBranch(b) }))] : []),
    ]);
  };

  const openDiff = (file: GitFileChange, source: 'working' | 'staged' | 'untracked') => {
    if (file.path.endsWith('/')) return;
    setUi({ modal: { kind: 'gitDiff', projectId, source, path: file.path, ...(file.origPath && source === 'staged' ? { oldPath: file.origPath } : {}), ...(worktree ? { worktree } : {}) } });
  };

  const fileMenu = (e: React.MouseEvent, file: GitFileChange, source: 'working' | 'staged' | 'untracked') => {
    e.preventDefault();
    const relative = status ? projectRelativePath(status.root, projectPath, file.path, window.mc.platform === 'win32') : null;
    const deleted = file.x === 'D' || file.y === 'D';
    const folder = file.path.endsWith('/');
    const usable = !!relative && !deleted && !folder && !worktree;
    openMenu(e.clientX, e.clientY, [
      { label: tr('Pokaż zmiany'), disabled: folder, onClick: () => openDiff(file, source) },
      { label: tr('Otwórz w edytorze'), disabled: !usable, onClick: () => { if (relative) void openFile(projectId, relative); } },
      { label: tr('Pokaż w panelu plików'), disabled: !usable, onClick: () => { if (relative) locateInFiles(projectId, relative); } },
      { sep: true },
      { label: tr('Kopiuj ścieżkę względną'), onClick: () => window.mc.clipboardWrite(file.path) },
    ]);
  };

  const selectValue = known?.path ?? worktrees.find((w) => same(w.path, projectPath))?.path ?? worktrees[0]?.path ?? '';
  const branchLabel = !status ? '' : status.branch ?? tr('Odłączony HEAD ({head})', { head: status.head });
  const conflicts = status?.files.filter((f) => f.conflict).length ?? 0;

  if (repo.error && !status) {
    return (
      <div className="sidebar-content git-panel">
        <p className="git-note error">{errorText(repo.error.message)}</p>
        <div className="git-note"><button className="btn small" onClick={() => repo.refresh(0)}>{tr('Spróbuj ponownie')}</button></div>
      </div>
    );
  }
  if (!status) return <div className="sidebar-content git-panel"><p className="git-note">{tr('Wczytywanie…')}</p></div>;

  return (
    <div className="sidebar-content git-panel">
      {worktrees.length > 1 && (
        <select className="git-worktree" aria-label={tr('Worktree')} value={selectValue} onChange={(e) => setPicked(e.target.value)}>
          {worktrees.map((w) => <option key={w.path} value={w.path}>{`${w.branch ?? tr('Odłączony HEAD ({head})', { head: w.head })} - ${w.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}`}</option>)}
        </select>
      )}
      <div className="git-bar">
        <button className="git-branch" onClick={(e) => void openBranches(e.currentTarget)} title={tr('Zmień gałąź')} aria-haspopup="menu">
          <IBranch /><span className="git-branch-name">{branchLabel}</span><IChevron />
        </button>
        {status.ahead > 0 && <span className="git-badge up" title={tr('Commitów do wysłania: {count}', { count: status.ahead })}>↑{status.ahead}</span>}
        {status.behind > 0 && <span className="git-badge down" title={tr('Commitów do pobrania: {count}', { count: status.behind })}>↓{status.behind}</span>}
        {conflicts > 0 && <span className="git-badge conflict" title={tr('Konflikt scalania')}>!{conflicts}</span>}
        <span className="git-spacer" />
        <button className="btn ghost icon small" onClick={() => { setNonce((n) => n + 1); repo.refresh(0); }} title={tr('Odśwież')} aria-label={tr('Odśwież')}><IRestart /></button>
      </div>
      {repo.error && <p className="git-note error" role="alert">{errorText(repo.error.message)}</p>}
      {status.upstream && <div className="git-upstream muted" title={status.upstream}>{tr('Śledzi: {upstream}', { upstream: status.upstream })}</div>}
      <div className="git-actions">
        <button className="btn small" disabled={!!busy} onClick={fetchNow} title={tr('Pobierz zmiany ze zdalnego repozytorium (fetch)')}>{busy === 'Fetch' ? '…' : 'Fetch'}</button>
        <button className="btn small" disabled={!!busy || !status.upstream} onClick={pullNow} title={status.upstream ? tr('Pobierz i dołącz zmiany (pull, tylko fast-forward)') : tr('Ta gałąź nie śledzi gałęzi zdalnej')}>{busy === 'Pull' ? '…' : 'Pull'}</button>
        <button className="btn small" disabled={!!busy || !status.push || (!status.ahead && !status.push.setUpstream)} onClick={() => void pushNow()} title={tr('Wyślij commity do zdalnego repozytorium (push)')}>{busy === 'Push' ? '…' : 'Push'}</button>
      </div>
      <GitChanges projectId={projectId} status={status} busy={!!busy} opts={opts} run={run} onOpen={openDiff} onMenu={fileMenu} />
      <GitHistory projectId={projectId} status={status} opts={opts} nonce={nonce} />
    </div>
  );
}
