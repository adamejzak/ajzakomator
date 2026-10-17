// Znane hosty in the SSH view (0.9.2): the trusted host keys (host, key type, fingerprint, added date) with removal, from the
// same mc.ssh calls as Settings > SSH. A read-only list (unreadable or newer file) says so and keeps every entry.
import { knownHostsDescription, readOnlyStoreNote } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { IShield } from '../icons';
import { useKnownHosts } from './useKnownHosts';

export function KnownHostsView() {
  const { tr, language } = useI18n();
  const { known, status, readOnly, remove } = useKnownHosts();
  const note = readOnlyStoreNote('knownHosts', readOnly, status?.knownHostsFile);
  return (
    <>
      <div className="ssh-view-titlebar"><h2 className="ssh-view-title">{tr('Znane hosty')}</h2></div>
      <p className="ssh-view-description">{tr(knownHostsDescription(status?.knownHostsFile), { file: status?.knownHostsFile ?? '' })}</p>
      {note && <div className="ssh-banner-warn" role="alert">{tr(note, { file: status?.knownHostsFile ?? '' })}</div>}
      {known && !known.length && (
        <div className="ssh-empty">
          <span className="ssh-empty-icon"><IShield /></span>
          <h3>{tr('Brak znanych hostów')}</h3>
          <p>{tr('Klucz serwera trafia tutaj, gdy przy pierwszym połączeniu wybierzesz „Zaufaj i zapisz”.')}</p>
        </div>
      )}
      {!!known?.length && (
        <ul className="ssh-known-list" aria-label={tr('Znane hosty')}>
          {known.map((k) => (
            <li key={k.id} className="ssh-known-row" data-known-id={k.id}>
              <div className="ssh-known-main">
                <span className="ssh-known-host">{k.display}</span>
                <span className="ssh-key-type">{k.keyType}</span>
                <span className="ssh-known-date">{k.addedAt ? tr('Dodano {date}', { date: new Date(k.addedAt).toLocaleDateString(language) }) : ''}</span>
              </div>
              <code className="ssh-fingerprint">{k.fingerprint}</code>
              <button className="btn small" disabled={readOnly} aria-label={tr('Usuń {host}', { host: k.display })} onClick={() => remove(k.id)}>{tr('Usuń')}</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
