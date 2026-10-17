import { appendFileSync, renameSync, statSync, writeFileSync } from 'fs';

const MAX_BYTES = 200 * 1024;

export interface LoggerOptions {
  /** A full file is moved here (replacing the older copy) instead of being emptied, so the lines before a crash survive. */
  rotateTo?: string;
}

/** electron-updater logger that keeps a small rolling file, so "why is there no update?" can be answered later. */
export function createUpdaterLogger(file: string, options: LoggerOptions = {}) {
  const write = (level: string, message: unknown) => {
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
        if (options.rotateTo) { try { renameSync(file, options.rotateTo); } catch { writeFileSync(file, ''); } }
        else writeFileSync(file, '');
      }
      const text = message instanceof Error ? `${message.message}\n${message.stack ?? ''}` : String(message);
      appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch { /* logging must never break updating */ }
  };
  return {
    info: (message?: unknown) => write('info', message),
    warn: (message?: unknown) => write('warn', message),
    error: (message?: unknown) => write('error', message),
    debug: (message: string) => write('debug', message),
  };
}
