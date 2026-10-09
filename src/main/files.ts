import { open, readdir, realpath } from 'fs/promises';
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
