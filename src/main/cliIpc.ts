// IPC surface of the CLI detection: validated, allow-listed. The renderer only ever names a CliId;
// documentation addresses come from CLI_DOCS, never from the renderer.
import { docsUrl, isCliId, type CliId, type CliStatusMap } from '../shared/cliStatus';
import type { InstallOptions, InstallStartResult } from '../shared/cliInstall';
import type { CliDetector } from './cliDetect';
import type { InstallManager } from './cliInstall';

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

export interface InstallHandlers {
  options(cli?: unknown): Promise<InstallOptions | null>;
  start(request?: unknown): Promise<InstallStartResult>;
  cancel(sessionId?: unknown): void;
}

/** The renderer names a CLI and a method; nothing else (no command text, no paths) is ever forwarded. */
export function createInstallHandlers(manager: Pick<InstallManager, 'options' | 'start' | 'cancel'>): InstallHandlers {
  return {
    options: (cli) => (isCliId(cli) ? manager.options(cli) : Promise.resolve(null)),
    start(request) {
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return Promise.resolve({ ok: false, error: 'invalid' });
      const { cli, method } = request as { cli?: unknown; method?: unknown };
      return manager.start({ cli, method });
    },
    cancel(sessionId) {
      if (typeof sessionId === 'string') manager.cancel(sessionId);
    },
  };
}
