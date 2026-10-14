import { Fragment, useCallback, useEffect, useState } from 'react';
import { compareVersions, parseNotes, type Block, type ChangelogEntry, type ChangelogResult, type Inline } from '../../../shared/changelog';
import { useI18n } from '../i18n';
import { closeModal } from '../store';
import { IX } from './icons';
import { RefreshIcon, useHoldBusy } from './Spinner';
import { useUpdateState } from './UpdateBadge';

const RELEASES_PAGE = 'https://github.com/daven-team/unimux/releases';

function Inlines({ items }: { items: Inline[] }) {
  return <>{items.map((item, i) => item.type === 'bold' ? <strong key={i}>{item.text}</strong> : item.type === 'code' ? <code key={i}>{item.text}</code> : <Fragment key={i}>{item.text}</Fragment>)}</>;
}

function Notes({ markdown }: { markdown: string }) {
  const blocks: Block[] = parseNotes(markdown);
  return <>{blocks.map((block, i) => block.type === 'list'
    ? <ul key={i}>{block.items.map((item, j) => <li key={j}><Inlines items={item} /></li>)}</ul>
    : block.type === 'heading'
      ? <h5 key={i}><Inlines items={block.inlines} /></h5>
      : <p key={i}><Inlines items={block.inlines} /></p>)}</>;
}

/** "What's new": release notes of the repository's GitHub releases, newest first. */
export function ChangelogModal() {
  const { tr, language } = useI18n();
  const { currentVersion } = useUpdateState();
  const [result, setResult] = useState<ChangelogResult | null>(null);
  const [loading, setLoading] = useState(true);
  const spinning = useHoldBusy(loading, 700);

  const load = useCallback((force: boolean) => {
    setLoading(true);
    window.mc.getChangelog(force)
      .then(setResult)
      .catch((error) => setResult({ entries: [], stale: false, error: String(error) }))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => load(false), [load]);

  const date = (iso: string) => {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(parsed);
  };
  const badge = (entry: ChangelogEntry) => {
    if (!currentVersion) return null;
    const order = compareVersions(entry.version, currentVersion);
    return order === 0 ? <span className="cl-badge current">{tr('Zainstalowana')}</span> : order > 0 ? <span className="cl-badge new">{tr('Nowa')}</span> : null;
  };

  return (
    <div className="modal changelog">
      <div className="modal-head">
        <h3>{tr('Co nowego')}</h3>
        <button className="btn ghost icon" onClick={closeModal} aria-label={tr('Zamknij')}><IX /></button>
      </div>
      <div className="modal-body">
        {result?.error && (
          <div className="cl-note" role="alert">
            {result.stale ? tr('Brak połączenia z GitHubem - pokazuję zapisaną kopię.') : tr('Nie udało się pobrać listy zmian.')}
            <button className="btn small" onClick={() => load(true)} disabled={spinning}><RefreshIcon spinning={spinning} />{tr('Ponów')}</button>
          </div>
        )}
        {!result && loading && <div className="muted">{tr('Ładowanie listy zmian…')}</div>}
        {result && !result.entries.length && !result.error && <div className="muted">{tr('Brak wpisów.')}</div>}
        {result?.entries.map((entry) => (
          <section key={entry.version} className="cl-entry">
            <header>
              <h4>v{entry.version}</h4>
              {badge(entry)}
              <span className="cl-date">{date(entry.date)}</span>
            </header>
            {entry.notes ? <Notes markdown={entry.notes} /> : <p className="muted">{tr('Brak opisu zmian.')}</p>}
          </section>
        ))}
      </div>
      <div className="modal-foot">
        <button className="btn refresh-button" onClick={() => load(true)} disabled={spinning}><RefreshIcon spinning={spinning} />{tr('Odśwież')}</button>
        <button className="btn" onClick={() => window.mc.openExternal(RELEASES_PAGE)}>{tr('Otwórz na GitHubie')}</button>
      </div>
    </div>
  );
}
