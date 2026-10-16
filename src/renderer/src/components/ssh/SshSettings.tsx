// Settings, section "SSH" (D12, spec 9 step 5): where secrets are kept, the trusted host keys, forgetting remembered passphrases.
// A store that opened read-only (unreadable, wrong shape, malformed entry or a newer format) is explained here, with its file path.
import { useEffect, useState } from 'react';
import { readOnlyStoreNote, storageLabel, type KnownHostInfo, type SshStorageStatus } from '../../../../shared/ssh';
import { useI18n } from '../../i18n';
import { toast } from '../../store';
import { useSshStore } from '../../sshStore';
import { SettingRow, SettingsGroup } from '../SettingRow';

export function SshSettings() {
  const { tr, language } = useI18n();
  const vault = useSshStore((st) => st.vault);
  const [known, setKnown] = useState<KnownHostInfo[] | null>(null);
  const [status, setStatus] = useState<SshStorageStatus | null>(null);
  const reload = () => void window.mc.ssh.knownHosts().then(setKnown).catch(() => setKnown([]));
  useEffect(() => {
    reload();
    void window.mc.ssh.storageStatus().then(setStatus).catch(() => undefined);
  }, []);
  const vaultReadOnly = !!vault?.readOnly || !!status?.vaultReadOnly;
  const hostsReadOnly = !!status?.knownHostsReadOnly;
  const vaultNote = readOnlyStoreNote('vault', vaultReadOnly);
  const hostsNote = readOnlyStoreNote('knownHosts', hostsReadOnly);
  const remove = (id: string) => void window.mc.ssh.removeKnownHost(id).then((r) => {
    if (!r.ok) toast(tr('Nie udało się usunąć wpisu'), 'error');
    reload();
  });
  return <>
    <SettingsGroup>
      <SettingRow title={tr('Sejf SSH')} hint={vault?.storage === 'unavailable' ? tr('Szyfrowanie systemowe jest niedostępne - klucze i hasła są trzymane tylko do zamknięcia aplikacji') : undefined}>
        <span>{tr(storageLabel(vault?.storage ?? 'unavailable'))}</span>
      </SettingRow>
      {vaultNote && <div className="ssh-banner-warn" role="alert">{tr(vaultNote, { file: status?.vaultFile ?? '' })}</div>}
      <SettingRow title={tr('Zapomnij zapamiętane hasła kluczy')} hint={tr('Hasła kluczy wpisane z opcją „Pamiętaj do zamknięcia aplikacji”.')}>
        <button className="btn" onClick={() => void window.mc.ssh.forgetPassphrases().then(() => toast(tr('Zapomniano zapamiętane hasła kluczy')))}>{tr('Zapomnij')}</button>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={tr('Znane hosty')}
      description={tr('Klucze hostów zaakceptowane z opcją „Zaufaj i zapisz”. Gdy zapis do pliku {file} się nie uda (brak uprawnień, brak miejsca albo plik tylko do odczytu), połączenie jest odrzucane z ogólnym błędem - sprawdź wtedy ten plik i spróbuj ponownie.', { file: status?.knownHostsFile ?? '' })}>
      {hostsNote && <div className="ssh-banner-warn" role="alert">{tr(hostsNote, { file: status?.knownHostsFile ?? '' })}</div>}
      {known && !known.length && <p className="muted">{tr('Brak znanych hostów')}</p>}
      {!!known?.length && (
        <table className="ssh-known">
          <tbody>
            {known.map((k) => (
              <tr key={k.id}>
                <td>{k.display}</td><td>{k.keyType}</td><td><code className="ssh-fingerprint">{k.fingerprint}</code></td>
                <td>{k.addedAt ? new Date(k.addedAt).toLocaleDateString(language) : '-'}</td>
                <td><button className="btn small" disabled={hostsReadOnly} onClick={() => remove(k.id)}>{tr('Usuń')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsGroup>
  </>;
}
