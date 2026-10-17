// Small, private files of main: the ssh/ directory is 0700 and its files 0600 on POSIX (on Windows the per-user %APPDATA% ACL applies).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'fs';
import { atomicWriteFileSync } from '../atomicWrite';

const posix = process.platform !== 'win32';

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (posix) { try { chmodSync(dir, 0o700); } catch { /* best effort */ } }
}

/** Atomic write (see atomicWrite.ts): a unique temp file next to the target, flushed, then renamed (retried on Windows locks). */
export function writePrivateFile(file: string, text: string): void {
  atomicWriteFileSync(file, text, { mode: 0o600 });
  if (posix) chmodSync(file, 0o600);
}

/**
 * Where an unparsable file is kept (M5): `<file>.bak-<ISO time>`, with a counter if that exists. An earlier backup is never
 * overwritten: a second corruption must not destroy the first backup, which may hold the original secrets.
 */
export function backupPath(file: string, now = new Date()): string {
  const base = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
  let candidate = base;
  for (let n = 2; existsSync(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

/** Reads a JSON file; an unparsable one is kept as a timestamped backup (see backupPath), never silently overwritten. */
export function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false; missing: boolean } {
  if (!existsSync(file)) return { ok: false, missing: true };
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return { ok: false, missing: false }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch {
    try { renameSync(file, backupPath(file)); } catch { /* best effort */ }
    return { ok: false, missing: false };
  }
}
