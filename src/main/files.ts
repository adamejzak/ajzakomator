import { open, readdir, realpath, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { isAbsolute, relative, resolve, sep } from 'path';
import type { ProjectDirectory, ProjectFilePreview } from '../shared/types';

export const PREVIEW_BYTES = 256 * 1024;
const DIRECTORY_LIMIT = 2000;

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Check both the requested path and its real target, including directory junctions. */
async function projectFilePath(projectRoot: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Ścieżka jest poza projektem.');
  const root = resolve(projectRoot);
  const requested = resolve(root, relativePath);
  if (!isInside(root, requested)) throw new Error('Ścieżka jest poza projektem.');
  const [realRoot, target] = await Promise.all([realpath(root), realpath(requested)]);
  if (!isInside(realRoot, target)) throw new Error('Ten link prowadzi poza folder projektu.');
  return target;
}

function fileError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Plik lub folder już nie istnieje. Odśwież listę.';
  if (code === 'EACCES' || code === 'EPERM') return 'Brak uprawnień do odczytu tego pliku lub folderu.';
  return error instanceof Error ? error.message : 'Nie udało się odczytać pliku lub folderu.';
}

export async function listProjectDirectory(root: string, path = ''): Promise<ProjectDirectory> {
  try {
    const target = await projectFilePath(root, path);
    const items = await readdir(target, { withFileTypes: true });
    const entries = items.filter((item) => item.isDirectory() || item.isFile() || item.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'pl', { numeric: true, sensitivity: 'base' }))
      .slice(0, DIRECTORY_LIMIT)
      .map((item) => ({
        name: item.name,
        path: [path.replace(/\\/g, '/').replace(/\/$/, ''), item.name].filter(Boolean).join('/'),
        kind: item.isDirectory() ? 'directory' as const : item.isSymbolicLink() ? 'symlink' as const : 'file' as const,
      }));
    return { ok: true, entries, truncated: items.length > DIRECTORY_LIMIT };
  } catch (error) {
    return { ok: false, error: fileError(error) };
  }
}

export async function readProjectFile(root: string, path: string): Promise<ProjectFilePreview> {
  try {
    const target = await projectFilePath(root, path);
    const file = await open(target, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return { kind: 'error', message: 'Wybierz plik, aby zobaczyć jego treść.' };
      const buffer = Buffer.alloc(PREVIEW_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const truncated = bytesRead > PREVIEW_BYTES;
      const data = buffer.subarray(0, Math.min(bytesRead, PREVIEW_BYTES));
      const utf16 = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
        : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : null;
      if (!utf16 && data.includes(0)) return { kind: 'binary', size: stat.size };
      try {
        const text = new TextDecoder(utf16 ?? 'utf-8', { fatal: true }).decode(data, { stream: truncated });
        if (/[\x00-\x08\x0e-\x1f]/.test(text)) return { kind: 'binary', size: stat.size };
        return { kind: 'text', text, size: stat.size, truncated };
      } catch {
        return { kind: 'binary', size: stat.size };
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    return { kind: 'error', message: fileError(error) };
  }
}

export type ProjectFileWriteResult = { ok: true } | { ok: false; error: string };

// Serialize our own saves so two tabs cannot both overwrite the same baseline.
const saves = new Map<string, Promise<ProjectFileWriteResult>>();
export async function writeProjectFile(root: string, path: string, text: string, expectedText: string): Promise<ProjectFileWriteResult> {
  try {
    if (typeof text !== 'string' || typeof expectedText !== 'string') throw new Error('Nieprawidłowa treść pliku.');
    const target = await projectFilePath(root, path);
    const previous = saves.get(target);
    const pending = (async () => {
      if (previous) await previous;
      return saveText(root, path, target, text, expectedText);
    })();
    saves.set(target, pending);
    try { return await pending; }
    finally { if (saves.get(target) === pending) saves.delete(target); }
  } catch (error) { return { ok: false, error: fileError(error) }; }
}

async function saveText(root: string, path: string, target: string, text: string, expectedText: string): Promise<ProjectFileWriteResult> {
  let temporary: string | undefined;
  try {
    const file = await open(target, 'r');
    let bytes: Buffer;
    let mode: number;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Wybierz plik, aby zapisać jego treść.');
      if (stat.size > PREVIEW_BYTES) throw new Error('Plik jest zbyt duży do bezpiecznej edycji.');
      mode = stat.mode;
      bytes = Buffer.alloc(PREVIEW_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, bytesRead);
      if (bytes.length > PREVIEW_BYTES) throw new Error('Plik jest zbyt duży do bezpiecznej edycji.');
    } finally { await file.close(); }
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    let baseline: string;
    try { baseline = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { throw new Error('Nie można edytować pliku binarnego lub nieobsługiwanego kodowania.'); }
    if (/[\x00-\x08\x0e-\x1f]/.test(baseline)) throw new Error('Nie można edytować pliku binarnego.');
    if (baseline !== expectedText) throw new Error('Plik zmienił się poza edytorem. Twój szkic został zachowany.');
    if (/[\x00-\x08\x0e-\x1f]/.test(text) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error('Nieprawidłowa treść pliku.');
    // Textareas normalize line breaks. Keep each original separator (including mixed files).
    const endings = baseline.match(/\r\n|\r|\n/g) ?? [];
    let index = 0;
    const normalized = text.replace(/\r\n|\r|\n/g, () => endings[index++] ?? endings[0] ?? '\n');
    let output: Buffer;
    if (encoding !== 'utf-8') {
      output = Buffer.from('\ufeff' + normalized, 'utf16le');
      if (encoding === 'utf-16be') output.swap16();
    } else {
      const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      output = Buffer.from((bom ? '\ufeff' : '') + normalized, 'utf8');
    }
    if (output.length > PREVIEW_BYTES) throw new Error('Plik jest zbyt duży do bezpiecznej edycji.');
    temporary = `${target}.mc-save-${randomUUID()}`;
    const staged = await open(temporary, 'wx', mode);
    try { await staged.writeFile(output); await staged.sync(); }
    finally { await staged.close(); }
    if (await projectFilePath(root, path) !== target) throw new Error('Plik zmienił się poza edytorem. Twój szkic został zachowany.');
    const current = await open(target, 'r');
    let unchanged = false;
    try {
      const stat = await current.stat();
      if (stat.isFile() && stat.size === bytes.length) {
        const check = Buffer.alloc(PREVIEW_BYTES + 1);
        const { bytesRead } = await current.read(check, 0, check.length, 0);
        unchanged = check.subarray(0, bytesRead).equals(bytes);
      }
    } finally { await current.close(); }
    if (!unchanged) throw new Error('Plik zmienił się poza edytorem. Twój szkic został zachowany.');
    await rename(temporary, target);
    temporary = undefined;
    return { ok: true };
  } catch (error) { return { ok: false, error: fileError(error) }; }
  finally { if (temporary) await unlink(temporary).catch(() => undefined); }
}
