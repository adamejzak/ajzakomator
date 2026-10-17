// Existence checks of project folders without blocking the main process: a folder on an offline network share can make a
// synchronous check hang for many seconds (the OS timeout). After `timeoutMs` the folder counts as unreachable.
import { access } from 'fs/promises';

export const EXISTS_TIMEOUT_MS = 4000;

export function pathExists(path: string, timeoutMs = EXISTS_TIMEOUT_MS): Promise<boolean> {
  if (typeof path !== 'string' || !path || path.includes('\0')) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    access(path).then(() => true, () => false).then((exists) => { clearTimeout(timer); resolve(exists); });
  });
}
