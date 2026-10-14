import { Select } from './Select';
// The Git panel of the left rail: the state of the active project's repository (branch, changes) and its history, with the
// everyday actions (fetch, pull --ff-only, push with confirmation, stage, commit, switch branch). Nothing destructive lives here.
// A repository whose own configuration can start programs stays read-only (history only) until the user trusts it.
import { useCallback, useEffect, useState } from 'react';
import { activeProject, findCell } from '../../../shared/state';
import {
  projectRelativePath, type GitBranch, type GitFileChange, type GitOpResult, type GitResult, type GitTrustInfo, type GitWorktree,
} from '../../../shared/git';
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

export function GitPanel() {
  const { tr } = useI18n();
  const project = useStore((st) => activeProject(st.s));
  const probe = useGitProbe(project?.id);
  if (!project) return <div className="sidebar-content git-panel"><p className="git-note">{tr('Najpierw dodaj projekt')}</p></div>;
  if (probe === 'no-repo') return <div className="sidebar-content git-panel"><p className="git-note">{tr('To nie jest repozytorium git')}</p></div>;
  if (probe === 'no-git') return <div className="sidebar-content git-panel"><p className="git-note">{tr('Nie znaleziono polecenia git. Zainstaluj Git (git-scm.com) i uruchom aplikację ponownie.')}</p></div>;
  return <RepoView key={`${project.id}:${project.path}`} projectId={project.id} projectPath={project.path} />;
}

const MAX_KEYS_SHOWN = 8;
/** Small, distinct transfer marks for the repository toolbar; labels and confirmations live on the buttons. */
function GitTransferIcon({ kind }: { kind: 'fetch' | 'pull' | 'push' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'push' ? <path d="M8 11V2M5 5l3-3 3 3" /> : <path d="M8 2v9M5 8l3 3 3-3" />}
      {kind === 'fetch' ? <path d="M3 14h2m2 0h2m2 0h2" /> : <path d="M3 11v3h10v-3" />}
    </svg>
  );
}

/** Why the repository is read-only, what in its configuration can start programs, and the way out: an explicit "trust". */
function TrustBanner({ keys, folded, onFold, onTrust }: { keys: string[]; folded: boolean; onFold(): void; onTrust(): void }) {
  const { tr } = useI18n();
  if (folded) {
    return (
      <div className="git-trust folded" role="note">
        <span>{tr('Tryb tylko do odczytu: historia działa, a zmiany, fetch, pull, push i commit są wyłączone, dopóki nie zaufasz repozytorium.')}</span>
        <button className="btn small" onClick={onTrust}>{tr('Zaufaj temu repozytorium')}</button>
      </div>
    );
  }
  return (
    <div className="git-trust" role="alert">
      <strong>{tr('To repozytorium ma w konfiguracji programy, które git może uruchomić')}</strong>
      <ul className="git-trust-keys">
        {keys.slice(0, MAX_KEYS_SHOWN).map((key) => <li key={key}><code>{key}</code></li>)}
        {keys.length > MAX_KEYS_SHOWN && <li>+{keys.length - MAX_KEYS_SHOWN}</li>}
      </ul>
      <div className="git-trust-actions">
        <button className="btn small primary" onClick={onTrust}>{tr('Zaufaj temu repozytorium')}</button>
        <button className="btn small" onClick={onFold}>{tr('Tryb tylko do odczytu')}</button>
      </div>
    </div>
  );
}

function RepoView({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const { tr, errorText } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [trust, setTrust] = useState<GitTrustInfo | null>(null);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [folded, setFolded] = useState(false);
  const [readOnlyHead, setReadOnlyHead] = useState<{ name: string | null; hash: string } | null>(null);
  const cellWorktree = useStore((st) => { const id = st.ui.focusedCellId; return id ? findCell(st.s, id)?.cell.worktree?.path : undefined; });

  // The worktree to show: the one the user picked, else the one of the focused cell, else the project folder itself.
  // Folders are matched in main by canonical path (short names, links and letter case do not matter), the answer comes as flags.
  const known = picked ? worktrees.find((w) => w.path === picked && w.allowed) : worktrees.find((w) => w.preferred && w.allowed);
  const worktree = known && !known.isProject ? known.path : undefined;
  const opts = worktree ? { worktree } : {};

  // Trust first: the status runs the repository's filters, so it is only asked for in a repository that is safe or trusted.
  const loadTrust = useCallback(async () => {
    try {
      const result = await window.mc.git.trust(projectId, worktree ? { worktree } : {});
      if (result.ok) { setTrust(result.data); setTrustError(null); }
      else setTrustError(result.error);
    } catch (e) { setTrustError(String(e)); }
  }, [projectId, worktree]);
  useEffect(() => {
    setTrust(null);
    void loadTrust();
    let timer: number | undefined;
    const onFocus = (): void => { window.clearTimeout(timer); timer = window.setTimeout(() => void loadTrust(), 300); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [loadTrust]);

  const untrusted = trust?.state === 'untrusted';
  const repo = useGitRepo(projectId, worktree, trust !== null && !untrusted);
  const { status } = repo;
  // The configuration changed under an open panel (the status was refused): look at the trust again.
  useEffect(() => { if (repo.error?.code === 'untrusted') void loadTrust(); }, [repo.error, loadTrust]);

  useEffect(() => {
    let cancelled = false;
    window.mc.git.worktrees(projectId, cellWorktree ? { prefer: cellWorktree } : {}).then((r) => { if (!cancelled && r.ok) setWorktrees(r.data); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, cellWorktree, status?.branch, status?.head, trust?.state]);

  // Read-only mode has no status: the branch comes from the branch list (which starts nothing).
  useEffect(() => {
    if (!untrusted) { setReadOnlyHead(null); return; }
    let cancelled = false;
    window.mc.git.branches(projectId, worktree ? { worktree } : {})
      .then((r) => { if (!cancelled && r.ok) { const current = r.data.find((b) => b.current); setReadOnlyHead(current ? { name: current.name, hash: current.hash } : { name: null, hash: '' }); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, worktree, untrusted, nonce]);

  const trustedWithPrograms = trust?.state === 'trusted' && trust.keys.length > 0;
  const programsNote = trustedWithPrograms ? tr('Hooki i filtry repozytorium mogą się przy tym uruchomić.') : null;
  const canWrite = !!status && !status.parent && !untrusted;

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
      void loadTrust();
    }
    return done;
  }, [busy, tr, errorText, repo, loadTrust]);

  /** The explicit "trust this repository": a confirmation naming the keys, then the dedicated request (main scans again and stores it). */
  const grantTrust = async () => {
    if (!trust) return;
    const keys = trust.keys.join(', ');
    const choice = await askChoice(
      tr('Zaufać temu repozytorium?'),
      tr('Git będzie mógł uruchamiać programy z konfiguracji tego repozytorium (hooki, filtry, polecenia) przy statusie, dodawaniu, commitach, fetch, pull i push. Zaufaj tylko repozytoriom, których autorom ufasz. Zmiana tej konfiguracji ponownie zapyta o zgodę.\n\nKlucze: {keys}', { keys }),
      [{ label: tr('Zaufaj'), value: 'trust', primary: true }],
    );
    if (choice !== 'trust') return;
    try {
      const result = await window.mc.git.trustGrant(projectId, { requestId: newRequestId(), ...opts });
      if (result.ok) { setTrust(result.data); setFolded(false); setNonce((n) => n + 1); }
      else toast(tr('Git: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) { toast(tr('Git: {error}', { error: String(e) }), 'error'); }
  };

  const revokeTrust = async () => {
    try {
      const result = await window.mc.git.trustRevoke(projectId, { requestId: newRequestId(), ...opts });
      if (result.ok) setTrust(result.data);
      else toast(tr('Git: {error}', { error: errorText(result.error) }), 'error');
    } catch (e) { toast(tr('Git: {error}', { error: String(e) }), 'error'); }
  };

  const hasLocalChanges = !!status?.files.some((f) => !f.untracked);

  const fetchNow = () => void run('Fetch', () => window.mc.git.fetch(projectId, { requestId: newRequestId(), ...opts }));
  const pullNow = () => void run('Pull', () => window.mc.git.pull(projectId, { requestId: newRequestId(), ...opts }));
  const pushNow = async () => {
    const push = status?.push;
    if (!status || !push) { toast(tr('Brak zdalnego repozytorium, do którego można wypchnąć tę gałąź.'), 'error'); return; }
    const lines = [
      tr('Gałąź {branch} zostanie wysłana do {target}.', { branch: status.branch ?? '', target: `${push.remote}/${push.branch}` }),
      tr('Adres docelowy: {url}', { url: push.url }),
    ];
    if (status.ahead) lines.push(tr('Commitów do wysłania: {count}', { count: status.ahead }));
    if (push.setUpstream) lines.push(tr('Ustawione zostanie też śledzenie gałęzi zdalnej.'));
    if (programsNote) lines.push(programsNote);
    const choice = await askChoice(tr('Wypchnąć zmiany?'), lines.join('\n'), [{ label: 'Push', value: 'push', primary: true }]);
    if (choice !== 'push') return;
    void run('Push', () => window.mc.git.push(projectId, { requestId: newRequestId(), remote: push.remote, branch: push.branch, urlId: push.urlId, ...opts }));
  };

  const switchBranch = async (branch: GitBranch) => {
    if (hasLocalChanges) { toast(tr('Masz niezatwierdzone zmiany. Zatwierdź je lub odłóż, zanim zmienisz gałąź.'), 'error'); return; }
    const body = [tr('Zmieni się zawartość plików w folderze projektu.'), ...(programsNote ? [programsNote] : [])].join('\n');
    const choice = await askChoice(tr('Przełączyć na gałąź „{branch}”?', { branch: branch.name }), body, [{ label: tr('Przełącz'), value: 'go', primary: true }]);
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
      ...local.map((b) => ({ label: b.name, hint: b.current ? tr('bieżąca') : b.track || undefined, disabled: b.current || !canWrite, onClick: () => void switchBranch(b) })),
      ...(remote.length ? [{ sep: true as const }, { header: tr('Zdalne') }, ...remote.map((b) => ({ label: b.name, disabled: !canWrite, onClick: () => void switchBranch(b) }))] : []),
    ]);
  };

  const openDiff = (file: GitFileChange, source: 'working' | 'staged' | 'untracked') => {
    if (file.path.endsWith('/')) return;
    setUi({ modal: { kind: 'gitDiff', projectId, source, path: file.path, ...(file.origPath && source === 'staged' ? { oldPath: file.origPath } : {}), ...(worktree ? { worktree } : {}) } });
  };

  const fileMenu = (e: React.MouseEvent, file: GitFileChange, source: 'working' | 'staged' | 'untracked') => {
    e.preventDefault();
    const relative = status ? projectRelativePath(status.projectRelation, file.path, window.mc.platform === 'win32') : null;
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

  const selectValue = known?.path ?? worktrees.find((w) => w.isProject)?.path ?? worktrees[0]?.path ?? '';
  const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
  const worktreeSelect = worktrees.length > 1 && (
    // every option shows its full path, so the user sees which folder a choice means; the ones the project may not use are disabled
    <Select className="select git-worktree" aria-label={tr('Worktree')} value={selectValue} onChange={(e) => setPicked(e.target.value)}>
      {worktrees.map((w) => (
        <option key={w.path} value={w.path} disabled={!w.allowed} title={w.path}>
          {`${w.branch ?? tr('Odłączony HEAD ({head})', { head: w.head })} - ${folderName(w.path)} (${w.path})`}
        </option>
      ))}
    </Select>
  );

  if (trustError && !trust) {
    return (
      <div className="sidebar-content git-panel">
        <p className="git-note error">{errorText(trustError)}</p>
        <div className="git-note"><button className="btn small" onClick={() => void loadTrust()}>{tr('Spróbuj ponownie')}</button></div>
      </div>
    );
  }
  if (!trust) return <div className="sidebar-content git-panel"><p className="git-note">{tr('Wczytywanie…')}</p></div>;

  // ----- read-only: not trusted yet
  if (untrusted) {
    const branchLabel = readOnlyHead ? readOnlyHead.name ?? 'HEAD' : '';
    return (
      <div className="sidebar-content git-panel">
        {worktreeSelect}
        <div className="git-bar">
          <span className="git-branch static" title={branchLabel}><IBranch /><span className="git-branch-name">{branchLabel}</span></span>
          <span className="git-badge conflict" title={tr('Tryb tylko do odczytu')}>{tr('Tryb tylko do odczytu')}</span>
          <span className="git-spacer" />
          <button className="btn ghost icon small" onClick={() => { setNonce((n) => n + 1); void loadTrust(); }} title={tr('Odśwież')} aria-label={tr('Odśwież')}><IRestart /></button>
        </div>
        <TrustBanner keys={trust.keys} folded={folded} onFold={() => setFolded(true)} onTrust={() => void grantTrust()} />
        <GitHistory projectId={projectId} historyKey={`ro:${readOnlyHead?.name ?? ''}:${readOnlyHead?.hash ?? ''}`} initial={false} opts={opts} nonce={nonce} />
      </div>
    );
  }

  if (repo.error && !status) {
    return (
      <div className="sidebar-content git-panel">
        <p className="git-note error">{errorText(repo.error.message)}</p>
        <div className="git-note"><button className="btn small" onClick={() => repo.refresh(0)}>{tr('Spróbuj ponownie')}</button></div>
      </div>
    );
  }
  if (!status) return <div className="sidebar-content git-panel"><p className="git-note">{tr('Wczytywanie…')}</p></div>;

  const branchLabel = status.branch ?? tr('Odłączony HEAD ({head})', { head: status.head });
  const conflicts = status.files.filter((f) => f.conflict).length;
  const historyKey = `${status.branch ?? ''}:${status.head}:${status.upstream ?? ''}:${status.ahead}:${status.behind}`;

  return (
    <div className="sidebar-content git-panel">
      {worktreeSelect}
      <div className="git-bar">
        <button className="git-branch" onClick={(e) => void openBranches(e.currentTarget)} title={tr('Zmień gałąź')} aria-haspopup="menu">
          <IBranch /><span className="git-branch-name">{branchLabel}</span><IChevron />
        </button>
        {status.ahead > 0 && <span className="git-badge up" title={tr('Commitów do wysłania: {count}', { count: status.ahead })}>↑{status.ahead}</span>}
        {status.behind > 0 && <span className="git-badge down" title={tr('Commitów do pobrania: {count}', { count: status.behind })}>↓{status.behind}</span>}
        {conflicts > 0 && <span className="git-badge conflict" title={tr('Konflikt scalania')}>!{conflicts}</span>}
        <span className="git-spacer" />
        <div className="git-actions" role="group" aria-label="Git">
          <button className="btn ghost icon small" disabled={!!busy || !canWrite} onClick={fetchNow} aria-label="Fetch" title={tr('Pobierz zmiany ze zdalnego repozytorium (fetch)')}>{busy === 'Fetch' ? '…' : <GitTransferIcon kind="fetch" />}</button>
          <button className="btn ghost icon small" disabled={!!busy || !canWrite || !status.upstream} onClick={pullNow} aria-label="Pull" title={status.upstream ? tr('Pobierz i dołącz zmiany (pull, tylko fast-forward)') : tr('Ta gałąź nie śledzi gałęzi zdalnej')}>{busy === 'Pull' ? '…' : <GitTransferIcon kind="pull" />}</button>
          <button className="btn ghost icon small" disabled={!!busy || !canWrite || !status.push || (!status.ahead && !status.push.setUpstream)} onClick={() => void pushNow()} aria-label="Push" title={tr('Wyślij commity do zdalnego repozytorium (push)')}>{busy === 'Push' ? '…' : <GitTransferIcon kind="push" />}</button>
        </div>
        <button className="btn ghost icon small" onClick={() => { setNonce((n) => n + 1); repo.refresh(0); void loadTrust(); }} title={tr('Odśwież')} aria-label={tr('Odśwież')}><IRestart /></button>
      </div>
      {repo.error && <p className="git-note error" role="alert">{errorText(repo.error.message)}</p>}
      {status.parent && <p className="git-note error" role="note">{tr('Repozytorium nadrzędne: ten projekt jest podfolderem większego repozytorium ({root}). Zmiany w nim są wyłączone.', { root: status.root })}</p>}
      {status.upstream && <div className="git-upstream muted" title={status.upstream}>{tr('Śledzi: {upstream}', { upstream: status.upstream })}</div>}
      {trustedWithPrograms && (
        <div className="git-trust folded" role="note">
          <span>{tr('Zaufane repozytorium: hooki i filtry z jego konfiguracji mogą się uruchamiać przy tych operacjach.')}</span>
          <button className="btn small" onClick={() => void revokeTrust()}>{tr('Cofnij zaufanie')}</button>
        </div>
      )}
      <GitChanges projectId={projectId} status={status} busy={!!busy} writable={canWrite} programsNote={programsNote} opts={opts} run={run} onOpen={openDiff} onMenu={fileMenu} />
      <GitHistory projectId={projectId} historyKey={historyKey} initial={status.initial} opts={opts} nonce={nonce} />
    </div>
  );
}
