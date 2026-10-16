// Keys of the vault (spec 10.1): click opens the key editor; the button copies the public key (public data).
import { useI18n } from '../../i18n';
import { toast } from '../../store';
import { useSshStore } from '../../sshStore';
import { openSshEditor } from '../../ssh';

const shortType = (type: string) => type.replace('ssh-', '').replace('ecdsa-sha2-nist', 'ecdsa-');

export function KeyList() {
  const { tr } = useI18n();
  const keys = useSshStore((st) => st.vault?.keys ?? []);
  if (!keys.length) return <p className="terminal-empty">{tr('Brak kluczy.')}</p>;
  return (
    <div className="ssh-keys">
      {keys.map((k) => (
        <div key={k.id} className="terminal-source">
          <button className="terminal-source-main" onClick={() => openSshEditor('key', k.id)} title={k.fingerprint}>
            <span className="terminal-source-name"><span className="ssh-key-type">{shortType(k.type)}</span>{k.label}{k.locked ? ' !' : ''}</span>
            <span className="terminal-source-detail">{k.fingerprint.slice(0, 19)}...</span>
          </button>
          <button className="btn ghost icon small" aria-label={tr('Kopiuj klucz publiczny')} title={tr('Kopiuj klucz publiczny')}
            onClick={() => { window.mc.clipboardWrite(k.publicKey); toast(tr('Skopiowano klucz publiczny')); }}>⧉</button>
        </div>
      ))}
    </div>
  );
}
