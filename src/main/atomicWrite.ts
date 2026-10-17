// One way to write the small JSON files of main (state.json, accounts.json, the SSH files, caches): a unique temp file next to the
// target, flushed to disk, then renamed over it. Windows file locks (Defender, the search indexer, OneDrive, backup tools) make
// the rename fail with EPERM / EBUSY / EACCES for a moment; it is retried with a short backoff instead of failing the save.
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'fs';

/** Error codes of a file another process holds for a moment (Windows mostly). */
export const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const isTransientFsError = (error: unknown): boolean =>
  TRANSIENT_FS_CODES.has(String((error as NodeJS.ErrnoException | null)?.code ?? ''));

/** Sleeps synchronously (the writers are synchronous; a few short waits only, never on a hot path). */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait possible: retry at once */ }
}

export interface AtomicWriteFs {
  openSync: typeof openSync;
  writeSync: (fd: number, data: Buffer) => number;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
  rmSync: (path: string) => void;
}

const realFs: AtomicWriteFs = {
  openSync, fsyncSync, closeSync, renameSync,
  writeSync: (fd, data) => writeSync(fd, data),
  rmSync: (path) => rmSync(path, { force: true }),
};

export interface AtomicWriteOptions {
  /** File mode of a new file (POSIX), for example 0o600 for private files. */
  mode?: number;
  /** Flush the temp file to disk before the rename (default true), so a power loss never leaves an empty target. */
  fsync?: boolean;
  /** Retries of a rename that hit a transient lock (default 5). */
  retries?: number;
  /** First wait between retries in ms; doubled each time (default 20). */
  backoffMs?: number;
  /** Test seams. */
  fs?: AtomicWriteFs;
  sleep?: (ms: number) => void;
}

let counter = 0;
/** A temp name no other writer (another instance on the same folder, an earlier failed write) can share. */
export const tempPathFor = (file: string): string => `${file}.${process.pid}.${Date.now().toString(36)}${(counter++).toString(36)}.tmp`;

/** Writes `data` to `file` atomically; throws the last error once the retries are used up (the temp file is removed then). */
export function atomicWriteFileSync(file: string, data: string | Buffer, options: AtomicWriteOptions = {}): void {
  const fs = options.fs ?? realFs;
  const sleep = options.sleep ?? sleepSync;
  const retries = options.retries ?? 5;
  const backoff = options.backoffMs ?? 20;
  const temp = tempPathFor(file);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  try {
    const fd = options.mode === undefined ? fs.openSync(temp, 'w') : fs.openSync(temp, 'w', options.mode);
    try {
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(fd, written === 0 ? bytes : bytes.subarray(written));
      if (options.fsync !== false) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        return;
      } catch (error) {
        if (attempt >= retries || !isTransientFsError(error)) throw error;
        sleep(backoff * 2 ** attempt);
      }
    }
  } catch (error) {
    try { fs.rmSync(temp); } catch { /* nothing left to clean */ }
    throw error;
  }
}
