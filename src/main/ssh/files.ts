// Small, private files of main: the ssh/ directory is 0700 and its files 0600 on POSIX (on Windows the per-user %APPDATA% ACL applies).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';

const posix = process.platform !== 'win32';

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (posix) { try { chmodSync(dir, 0o700); } catch { /* best effort */ } }
}

/** Atomic write: a temp file next to the target, then rename. */
export function writePrivateFile(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
    if (posix) chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Reads a JSON file; an unparsable one is kept as <file>.bak (never silently overwritten). */
export function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false; missing: boolean } {
  if (!existsSync(file)) return { ok: false, missing: true };
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return { ok: false, missing: false }; }
  try { return { ok: true, value: JSON.parse(text) }; } catch {
    try { renameSync(file, `${file}.bak`); } catch { /* best effort */ }
    return { ok: false, missing: false };
  }
}
