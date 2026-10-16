// One key of the vault (spec 10.2, 7.4, D6, D9). Public parts are shown and copied; the private key only goes to a file, through main.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClearWhenHidden } from './paneVisibility';
import { draftErrorKey, READ_ONLY_VAULT_HINT, hostsUsingKey, labelFieldValue, type KeyError } from '../../../../shared/ssh';
import type { MessageKey } from '../../../../shared/i18n';
import { useI18n } from '../../i18n';
import { askChoice, toast, useStore } from '../../store';
import { useSshStore } from '../../sshStore';
import { showSshDetail } from '../../ssh';

/** A failed change of a stored key is a write failure, not a failed generation. */
const changeErrorKey = (error: KeyError): MessageKey | null => (error === 'failed' ? 'Nie udało się zapisać zmian' : draftErrorKey(error));

export function KeyEditor({ keyId }: { keyId: string }) {
  const { tr } = useI18n();
  const key = useSshStore((st) => st.vault?.keys.find((k) => k.id === keyId));
  const readOnly = useSshStore((st) => !!st.vault?.readOnly);
  const allHosts = useStore((st) => st.s.sshHosts);
  const hosts = useMemo(() => hostsUsingKey(allHosts, keyId), [allHosts, keyId]);
  const [label, setLabel] = useState(key?.label ?? '');
  const labelFocused = useRef(false);
  // A rename elsewhere or a late vault push shows up unless the user is typing in the field.
  const storedLabel = key?.label ?? '';
  useEffect(() => { setLabel((field) => labelFieldValue({ field, stored: storedLabel, focused: labelFocused.current })); }, [storedLabel]);
  const [certificate, setCertificate] = useState('');
  const [passphrase, setPassphrase] = useState('');
  useClearWhenHidden(() => setPassphrase(''));
  const [error, setError] = useState<string | null>(null);
  if (!key) return <div className="ssh-editor"><p className="ssh-card-hint">{tr('Klucz przypisany do hosta nie istnieje')}</p></div>;

  const change = async (p: Promise<{ ok: true } | { ok: false; error: KeyError }>): Promise<boolean> => {
    const r = await p;
    const message = r.ok ? null : changeErrorKey(r.error);
    setError(message ? tr(message) : null);
    return r.ok;
  };
  const saveLabel = () => {
    const next = label.trim();
    if (!next) { setLabel(key.label); return; }
    if (next !== key.label) void change(window.mc.ssh.updateKey({ id: key.id, label: next }));
  };
  const exportKey = async () => {
    const r = await window.mc.ssh.exportPrivateKey(key.id);
    if (r.ok || r.error === 'cancelled') { setError(null); return; }
    setError(tr(r.error === 'locked' ? 'Nie można odczytać klucza na tym komputerze' : r.error === 'notFound' ? 'Klucz przypisany do hosta nie istnieje' : 'Nie udało się zapisać pliku'));
  };
  const remove = async () => {
    const title = hosts.length ? tr('Klucz jest używany przez {count} hostów. Usunąć go?', { count: hosts.length }) : tr('Usunąć klucz {name}?', { name: key.label });
    if (await askChoice(title, '', [{ label: tr('Usuń klucz'), value: 'yes', danger: true }]) !== 'yes') return;
    if ((await window.mc.ssh.removeKey(key.id)).ok) showSshDetail(null);
    else setError(tr('Nie udało się zapisać zmian'));
  };
  const copyPublic = () => { window.mc.clipboardWrite(key.publicKey); toast(tr('Skopiowano klucz publiczny')); };

  return (
    <div className="ssh-editor">
      <h2>{key.label}</h2>
      {readOnly && <div className="ssh-banner-warn">{tr(READ_ONLY_VAULT_HINT)}</div>}
      {key.locked && <div className="ssh-error">{tr('Nie można odczytać tego sekretu na tym komputerze. Usuń go i dodaj ponownie.')}</div>}
      {key.ephemeral && <div className="ssh-card-hint">{tr('do zamknięcia aplikacji')}</div>}
      {error && <div className="ssh-error" role="alert">{error}</div>}
      <div className="ssh-section">
        <label className="ssh-field"><span>{tr('Etykieta')}</span>
          <input className="input" value={label} maxLength={80} disabled={readOnly} onChange={(e) => setLabel(e.target.value)} onFocus={() => { labelFocused.current = true; }} onBlur={() => { labelFocused.current = false; saveLabel(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </label>
        <dl className="ssh-facts">
          <dt>{tr('Typ')}</dt><dd>{key.type}</dd>
          <dt>{tr('Rozmiar')}</dt><dd>{key.bits}</dd>
          <dt>{tr('Odcisk')}</dt><dd><code className="ssh-fingerprint">{key.fingerprint}</code></dd>
          <dt>{tr('Komentarz')}</dt><dd>{key.comment || '-'}</dd>
        </dl>
      </div>
      <div className="ssh-section">
        <div className="ssh-field"><span>{tr('Klucz publiczny')}</span>
          <pre className="ssh-public">{key.publicKey}</pre>
          <div className="ssh-row"><button type="button" className="btn" onClick={copyPublic}>{tr('Kopiuj klucz publiczny')}</button></div>
        </div>
      </div>
      <div className="ssh-section">
        <div className="ssh-field"><span>{tr('Certyfikat')}</span>
          {key.certificate && <span className="ssh-card-hint">{tr('Certyfikat jest zapisany, ale logowanie certyfikatem nie jest jeszcze obsługiwane')}</span>}
          {key.certificate && <pre className="ssh-public">{key.certificate}</pre>}
          {!readOnly && <>
            <textarea className="input mono" rows={2} value={certificate} spellCheck={false} onChange={(e) => setCertificate(e.target.value)} />
            <div className="ssh-row">
              <button type="button" className="btn" disabled={!certificate.trim()} onClick={() => void change(window.mc.ssh.updateKey({ id: key.id, certificate: certificate.trim() })).then((ok) => ok && setCertificate(''))}>{tr('Zastąp certyfikat')}</button>
              {key.certificate && <button type="button" className="btn" onClick={() => void change(window.mc.ssh.updateKey({ id: key.id, certificate: null }))}>{tr('Usuń certyfikat')}</button>}
            </div>
          </>}
        </div>
        {key.encrypted && !readOnly && <div className="ssh-field"><span>{tr('Hasło klucza')}</span>
          {key.passphraseSaved
            ? <div className="ssh-row"><button type="button" className="btn" onClick={() => void change(window.mc.ssh.updateKey({ id: key.id, passphrase: { forget: true } }))}>{tr('Zapomnij zapisane hasło')}</button></div>
            : <div className="ssh-row"><input className="input grow" type="password" autoComplete="off" value={passphrase} maxLength={1024} onChange={(e) => setPassphrase(e.target.value)} />
                <button type="button" className="btn" disabled={!passphrase || key.locked} onClick={() => { const value = passphrase; setPassphrase(''); void change(window.mc.ssh.updateKey({ id: key.id, passphrase: { save: value } })); }}>{tr('Zapisz hasło klucza')}</button></div>}
        </div>}
        <div className="ssh-field"><span>{tr('Hosty używające klucza')}</span>
          {hosts.length ? <ul className="ssh-list">{hosts.map((h) => <li key={h.id}><button type="button" className="btn small ghost" onClick={() => showSshDetail({ kind: 'host', hostId: h.id })}>{h.label}</button></li>)}</ul> : <span className="ssh-card-hint">-</span>}
        </div>
      </div>
      <div className="ssh-actions">
        <button type="button" className="btn" disabled={key.locked} onClick={() => void exportKey()}>{tr('Zapisz klucz prywatny do pliku...')}</button>
        <span className="grow" />
        {!readOnly && <button type="button" className="btn danger" onClick={() => void remove()}>{tr('Usuń klucz')}</button>}
      </div>
    </div>
  );
}
