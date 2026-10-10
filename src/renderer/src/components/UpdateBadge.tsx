import { useEffect, useState } from 'react';
import type { UpdateState } from '../../../shared/types';

/** IPC failures from the brand menu are also surfaced in the badge. */
export function requestUpdateCheck(): void {
  void window.mc.checkUpdates().catch((error) => {
    window.dispatchEvent(new CustomEvent('update:renderer-error', { detail: String(error) }));
  });
}

export function formatUpdateBytes(bytes = 0): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}

/** Live updater state plus the running version; shared by every place that shows update status. */
export function useUpdateState(): { update: UpdateState; currentVersion: string } {
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  const [currentVersion, setCurrentVersion] = useState('');
  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    const unsubscribe = window.mc.on('update:state', (next) => { receivedEvent = true; if (mounted) setUpdate(next); });
    const failed = (event: Event) => { receivedEvent = true; setUpdate({ status: 'error', message: (event as CustomEvent<string>).detail }); };
    window.addEventListener('update:renderer-error', failed);
    void window.mc.getUpdate().then((next) => {
      if (!mounted) return;
      setCurrentVersion(next.currentVersion);
      if (!receivedEvent) setUpdate(next);
    }).catch((error) => { if (mounted && !receivedEvent) setUpdate({ status: 'error', message: String(error) }); });
    return () => { mounted = false; unsubscribe(); window.removeEventListener('update:renderer-error', failed); };
  }, []);
  return { update, currentVersion };
}
