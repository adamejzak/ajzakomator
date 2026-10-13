import { useState } from 'react';
import type { GitFileChange, GitOpResult, GitResult, GitStatus } from '../../../shared/git';
import { useI18n } from '../i18n';
import { baseName, CONFLICT_LETTER, dirName, groupChanges, letterOf, newRequestId, type ChangeGroup, type Letter } from '../../../shared/gitUi';
import { IChevron } from './icons';
import { matchesShortcut, titleWithShortcut } from '../shortcuts';

type Source = 'working' | 'staged' | 'untracked';

interface Props {
  projectId: string;
  status: GitStatus;
  busy: boolean;
  opts: { worktree?: string };
  run(action: string, call: () => Promise<GitResult<GitOpResult>>, quiet?: boolean): Promise<boolean>;
  onOpen(file: GitFileChange, source: Source): void;
  onMenu(e: React.MouseEvent, file: GitFileChange, source: Source): void;
}

/** The Changes section: files grouped as conflicts, staged, changed and untracked, with stage / unstage and a commit box. */
export function GitChanges({ projectId, status, busy, opts, run, onOpen, onMenu }: Props) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState('');
  const groups = groupChanges(status.files);
  const total = status.files.length;
  const staged = groups.staged.length;

  const stage = (paths: string[], all = false) => void run('Stage', () => window.mc.git.stage(projectId, { requestId: newRequestId(), paths, ...(all ? { all: true } : {}), ...opts }), true);
  const unstage = (paths: string[], all = false) => void run('Unstage', () => window.mc.git.unstage(projectId, { requestId: newRequestId(), paths, ...(all ? { all: true } : {}), ...opts }), true);
  const pathsOf = (files: GitFileChange[]) => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));

  const commit = async () => {
    if (!message.trim() || !staged) return;
    const ok = await run('Commit', () => window.mc.git.commit(projectId, { requestId: newRequestId(), message, ...opts }));
    if (ok) setMessage('');
  };

  const group = (id: ChangeGroup, title: string, files: GitFileChange[]) => {
    if (!files.length) return null;
    const source: Source = id === 'staged' ? 'staged' : id === 'untracked' ? 'untracked' : 'working';
    const bulk = id === 'staged'
      ? { label: tr('Usuń wszystko z commita'), onClick: () => unstage([], true) }
      : { label: tr('Dodaj wszystko do commita'), onClick: () => stage([], true) };
    return (
      <div className="git-group" key={id}>
        <div className="git-group-head">
          <span>{title} <span className="git-count">{files.length}</span></span>
          {id !== 'conflict' && <button className="btn ghost small" disabled={busy} onClick={bulk.onClick} title={bulk.label} aria-label={bulk.label}>{id === 'staged' ? '−' : '+'}</button>}
        </div>
        {files.map((file) => {
          const letter: Letter = id === 'conflict' ? CONFLICT_LETTER : id === 'staged' ? letterOf(file.x) : letterOf(file.untracked ? '?' : file.y);
          return (
            <div
              key={`${id}:${file.path}`}
              className="git-file"
              role="button"
              tabIndex={0}
              title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
              onClick={() => onOpen(file, source)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(file, source); }}
              onContextMenu={(e) => onMenu(e, file, source)}
            >
              <span className={`git-letter ${letter.cls}`} title={tr(letter.title)}>{letter.letter}</span>
              <span className="git-file-name">{baseName(file.path)}<span className="git-file-dir">{dirName(file.path)}</span></span>
              <button
                className="btn ghost small git-file-action"
                disabled={busy}
                aria-label={id === 'staged' ? tr('Usuń z commita') : tr('Dodaj do commita')}
                title={id === 'staged' ? tr('Usuń z commita') : tr('Dodaj do commita')}
                onClick={(e) => { e.stopPropagation(); if (id === 'staged') unstage(pathsOf([file])); else stage(pathsOf([file])); }}
              >{id === 'staged' ? '−' : '+'}</button>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section className="git-changes" aria-label={tr('Zmiany')}>
      <button className="git-section-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`tree-chevron ${open ? 'open' : ''}`}><IChevron /></span>
        <span>{tr('Zmiany')}</span>
        <span className="git-count">{total}</span>
      </button>
      {open && (
        <div className="git-changes-body">
          {!total && <p className="git-note muted">{tr('Brak zmian.')}</p>}
          {group('conflict', tr('Konflikty'), groups.conflict)}
          {group('staged', tr('Do zatwierdzenia'), groups.staged)}
          {group('unstaged', tr('Niedodane'), groups.unstaged)}
          {group('untracked', tr('Nieśledzone'), groups.untracked)}
          {status.truncated && <p className="git-note muted">{tr('Pokazano pierwsze {count} zmian.', { count: status.files.length })}</p>}
        </div>
      )}
      {open && staged > 0 && (
        <div className="git-commit-box">
          <textarea
            className="input"
            rows={2}
            value={message}
            placeholder={tr('Opis commita')}
            aria-label={tr('Opis commita')}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (matchesShortcut('git.commit', e)) { e.preventDefault(); void commit(); } }}
          />
          <button className="btn small primary" disabled={busy || !message.trim()} onClick={() => void commit()} title={titleWithShortcut(tr('Zatwierdź dodane pliki'), 'git.commit')}>
            {tr('Commit')} ({staged})
          </button>
        </div>
      )}
    </section>
  );
}
