// IPC surface of the CLI detection: validated, allow-listed. The renderer only ever names a CliId;
// documentation addresses come from CLI_DOCS, never from the renderer.
import { docsUrl, isCliId, type CliId, type CliStatusMap } from '../shared/cliStatus';
import type { CliDetector } from './cliDetect';

export interface CliHandlers {
  status(): CliStatusMap;
  recheck(id?: unknown): Promise<CliStatusMap>;
  openDocs(id?: unknown): boolean;
}

export function createCliHandlers(detector: Pick<CliDetector, 'snapshot' | 'recheck'>, openExternal: (url: string) => void): CliHandlers {
  // Several "check again" clicks (or focus events) while one check runs share it.
  const running = new Map<string, Promise<CliStatusMap>>();
  return {
    status: () => detector.snapshot(),
    recheck(id) {
      if (id !== undefined && id !== null && !isCliId(id)) return Promise.reject(new Error('Unknown CLI.'));
      const cli: CliId | undefined = id === undefined || id === null ? undefined : (id as CliId);
      const key = cli ?? '*';
      const existing = running.get(key);
      if (existing) return existing;
      const run = detector.recheck(cli).finally(() => { running.delete(key); });
      running.set(key, run);
      return run;
    },
    openDocs(id) {
      if (!isCliId(id)) return false;
      openExternal(docsUrl(id));
      return true;
    },
  };
}
