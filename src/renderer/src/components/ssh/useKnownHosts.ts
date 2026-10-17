// The trusted host keys and the store status (read-only, file paths), shared by Settings > SSH and the SSH view's Znane hosty.
// Read and removed through mc.ssh; a list is fetched when its screen mounts, so a key trusted meanwhile shows up there.
import { useCallback, useEffect, useState } from 'react';
import type { KnownHostInfo, SshStorageStatus } from '../../../../shared/ssh';
import { tr } from '../../i18n';
import { toast } from '../../store';

export function useKnownHosts(): { known: KnownHostInfo[] | null; status: SshStorageStatus | null; readOnly: boolean; remove(id: string): void } {
  const [known, setKnown] = useState<KnownHostInfo[] | null>(null);
  const [status, setStatus] = useState<SshStorageStatus | null>(null);
  const reload = useCallback(() => void window.mc.ssh.knownHosts().then(setKnown).catch(() => setKnown([])), []);
  useEffect(() => {
    reload();
    void window.mc.ssh.storageStatus().then(setStatus).catch(() => undefined);
  }, [reload]);
  const remove = (id: string) => void window.mc.ssh.removeKnownHost(id).then((r) => {
    if (!r.ok) toast(tr('Nie udało się usunąć wpisu'), 'error');
    reload();
  });
  return { known, status, readOnly: !!status?.knownHostsReadOnly, remove };
}
