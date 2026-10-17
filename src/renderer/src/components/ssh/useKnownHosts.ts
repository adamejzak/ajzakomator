// The trusted host keys and the store status (read-only, file paths), shared by Settings > SSH and the SSH view's Znane hosty.
// Read and removed through mc.ssh; fetched when its screen mounts and again when it may have changed (see useKnownHosts).
import { useCallback, useEffect, useState } from 'react';
import type { KnownHostInfo, SshStorageStatus } from '../../../../shared/ssh';
import { tr } from '../../i18n';
import { toast } from '../../store';
import { useSshStore } from '../../sshStore';

/**
 * `readOnly` is also true while the store status is still loading, so Remove is never offered on a list that may turn out
 * read-only. The list is fetched again when a host key prompt of a cell closes (it may have trusted a key) and when the
 * window gets the focus back.
 */
export function useKnownHosts(): { known: KnownHostInfo[] | null; status: SshStorageStatus | null; readOnly: boolean; remove(id: string): void } {
  const [known, setKnown] = useState<KnownHostInfo[] | null>(null);
  const [status, setStatus] = useState<SshStorageStatus | null>(null);
  const hostKeyPrompts = useSshStore((st) => Object.values(st.prompts).filter((p) => p.kind === 'hostKey').map((p) => p.id).join(','));
  const reload = useCallback(() => void window.mc.ssh.knownHosts().then(setKnown).catch(() => setKnown([])), []);
  useEffect(() => {
    void window.mc.ssh.storageStatus().then(setStatus).catch(() => undefined);
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  useEffect(reload, [reload, hostKeyPrompts]);
  const remove = (id: string) => void window.mc.ssh.removeKnownHost(id).then((r) => {
    if (!r.ok) toast(tr('Nie udało się usunąć wpisu'), 'error');
    reload();
  });
  return { known, status, readOnly: !status || status.knownHostsReadOnly, remove };
}
