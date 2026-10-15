// Pull requests and issues of the project's GitHub repository: a folded section of the Git panel, read when it is opened.
import { useCallback, useEffect, useState } from 'react';
import type { GithubKind, GithubResult } from '../../../shared/github';
import { formatAgo } from '../../../shared/i18n';
import { useI18n } from '../i18n';
import { IChevron } from './icons';
import { RefreshIcon, useHoldBusy } from './Spinner';

export function GitGithub({ projectId, nonce }: { projectId: string; nonce: number }) {
  const { tr, language, errorText } = useI18n();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<GithubKind>('pulls');
  const [result, setResult] = useState<GithubResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloads, setReloads] = useState(0);
  const spinning = useHoldBusy(loading, 600);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    window.mc.git.github(projectId, kind)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => { if (!cancelled) setResult({ ok: false, code: 'failed', error: String(e) }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, kind]);
  useEffect(() => (open ? load() : undefined), [open, load, nonce, reloads]);

  // A repository without a GitHub address has nothing to list here.
  if (result && !result.ok && result.code === 'no-github') return null;
  const items = result?.ok ? result.items : [];

  return (
    <section className="git-github" aria-label={tr('Pull requesty i issues')}>
      <div className="git-section-bar">
        <button className="git-section-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className={`tree-chevron ${open ? 'open' : ''}`}><IChevron /></span>
          <span>{tr('Pull requesty i issues')}</span>
          {result?.ok && <span className="git-count">{items.length}{result.hasMore ? '+' : ''}</span>}
        </button>
        {open && <button className="btn ghost icon small" onClick={() => setReloads((n) => n + 1)} title={tr('Odśwież')} aria-label={tr('Odśwież')}><RefreshIcon spinning={spinning} /></button>}
      </div>
      {open && (
        <div className="git-github-body">
          <div className="git-github-tabs" role="tablist">
            {(['pulls', 'issues'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'pulls' ? tr('Pull requesty') : tr('Issues')}</button>
            ))}
          </div>
          {result && !result.ok && <p className="git-note error">{errorText(result.error)}</p>}
          {result?.ok && !items.length && <p className="git-note muted">{kind === 'pulls' ? tr('Brak otwartych pull requestów.') : tr('Brak otwartych issues.')}</p>}
          {!result && loading && <p className="git-note muted">{tr('Wczytywanie…')}</p>}
          <div className="git-github-list">
            {items.map((item) => (
              <button key={item.number} className="git-pr" onClick={() => window.mc.openExternal(item.url)} title={`${item.title}\n${tr('Otwórz na GitHubie')}`}>
                <span className="git-pr-title"><span className="git-pr-num">#{item.number}</span>{item.title}{item.draft && <span className="git-chip">{tr('szkic')}</span>}</span>
                <span className="git-pr-meta muted">{[item.author, item.updatedAt ? formatAgo(language, Date.parse(item.updatedAt)) : '', item.comments ? `💬 ${item.comments}` : ''].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
