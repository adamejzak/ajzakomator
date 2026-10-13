// Filesystem mutations of the project tree. Everything is confined to the project root exactly like the read
// handlers in files.ts: no absolute paths, no "..", no symlink or junction escapes (real paths are compared),
// and nothing is ever deleted permanently (replaced and deleted items go to the trash).
import { constants } from 'fs';
import { copyFile, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, stat, symlink, utimes } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { AppPlatform } from '../shared/platform';
import {
  copyName, joinPath, LARGE_COPY_BYTES, LARGE_COPY_ENTRIES, MAX_OP_PATH_LENGTH, parentPath, toPosix, topLevelPaths, validPathList, validateEntryName,
  type ConflictPolicy, type CreateResult, type DeleteResult, type FileConflict, type FileMoveRecord, type FileOpFailure,
  type FileOpProgress, type FileOpRequest, type FileOpResult, type RenameResult,
} from '../shared/fileOps';

/** Moves one absolute path to the OS trash (Electron's shell.trashItem; replaceable in tests). */
export type TrashFn = (absolutePath: string) => Promise<void>;

export interface FileOpOptions {
  trash: TrashFn;
  platform?: AppPlatform;
  signal?: AbortSignal;
  onProgress?: (progress: Omit<FileOpProgress, 'opId'>) => void;
  limits?: { bytes: number; entries: number };
  /** Test hooks: replace the filesystem calls that cannot be provoked portably (EXDEV, link creation). */
  hooks?: { rename?: typeof rename; symlink?: typeof symlink };
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const norm = (path: string): string => (CASE_INSENSITIVE ? path.toLowerCase() : path);
const platformOf = (options: { platform?: AppPlatform }): AppPlatform => options.platform ?? (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux');

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function sameOrInside(parent: string, child: string): boolean {
  const a = norm(parent), b = norm(child);
  return a === b || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

class OpError extends Error {}

function opMessage(error: unknown): string {
  if (error instanceof OpError) return error.message;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Plik lub folder już nie istnieje. Odśwież listę.';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'Brak uprawnień lub element jest używany przez inny program.';
  if (code === 'EEXIST') return 'Element o takiej nazwie już istnieje.';
  if (code === 'ENAMETOOLONG') return 'Nazwa jest zbyt długa.';
  if (code === 'ENOSPC') return 'Brak miejsca na dysku.';
  return error instanceof Error ? error.message : 'Operacja na plikach nie powiodła się.';
}

interface Entry { rel: string; name: string; real: string; parentReal: string }
interface Context { root: string; realRoot: string }

async function context(projectRoot: string): Promise<Context> {
  const root = resolve(projectRoot);
  return { root, realRoot: await realpath(root) };
}

/** Resolves an entry of the project (never the root itself). The entry may itself be a link: only its parent is resolved. */
async function entryOf(ctx: Context, relPath: unknown): Promise<Entry> {
  if (typeof relPath !== 'string' || relPath.length > MAX_OP_PATH_LENGTH || relPath.includes('\0') || isAbsolute(relPath) || /^[a-z]:/i.test(relPath)) throw new OpError('Ścieżka jest poza projektem.');
  const rel = toPosix(relPath);
  if (!rel) throw new OpError('Nie można zmieniać katalogu głównego projektu.');
  if (rel.split('/').some((part) => part === '..' || part === '.')) throw new OpError('Ścieżka jest poza projektem.');
  const requested = resolve(ctx.root, rel);
  if (!isInside(ctx.root, requested) || requested === ctx.root) throw new OpError('Ścieżka jest poza projektem.');
  const parentReal = await realpath(dirname(requested));
  if (!sameOrInside(ctx.realRoot, parentReal)) throw new OpError('Ten link prowadzi poza folder projektu.');
  const name = basename(requested);
  return { rel, name, real: join(parentReal, name), parentReal };
}

/** An existing folder inside the project ('' = the root), as a real path. */
async function folderOf(ctx: Context, relPath: unknown): Promise<{ rel: string; real: string }> {
  if (typeof relPath !== 'string' || relPath.length > MAX_OP_PATH_LENGTH || relPath.includes('\0') || isAbsolute(relPath) || /^[a-z]:/i.test(relPath)) throw new OpError('Ścieżka jest poza projektem.');
  const rel = toPosix(relPath);
  if (rel.split('/').some((part) => part === '..' || part === '.')) throw new OpError('Ścieżka jest poza projektem.');
  const requested = resolve(ctx.root, rel);
  if (!isInside(ctx.root, requested)) throw new OpError('Ścieżka jest poza projektem.');
  const real = await realpath(requested);
  if (!sameOrInside(ctx.realRoot, real)) throw new OpError('Ten link prowadzi poza folder projektu.');
  if (!(await stat(real)).isDirectory()) throw new OpError('Miejsce docelowe nie jest folderem.');
  return { rel, real };
}

const lstatOrNull = (path: string) => lstat(path).catch(() => null);

async function sameFile(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([lstat(a, { bigint: true }).catch(() => null), lstat(b, { bigint: true }).catch(() => null)]);
  return !!x && !!y && x.ino !== 0n && x.ino === y.ino && x.dev === y.dev;
}

// ---------- rename ----------

export async function renameProjectEntry(projectRoot: string, path: string, newName: string, options: Pick<FileOpOptions, 'platform'> = {}): Promise<RenameResult> {
  try {
    const ctx = await context(projectRoot);
    const entry = await entryOf(ctx, path);
    if (typeof newName !== 'string') throw new OpError('Nazwa nie może być pusta.');
    const invalid = validateEntryName(newName, platformOf(options));
    if (invalid) throw new OpError(invalid);
    const parent = parentPath(entry.rel);
    const to = joinPath(parent, newName);
    if (newName === entry.name) return { ok: true, from: entry.rel, to };
    if (!await lstatOrNull(entry.real)) throw new OpError('Plik lub folder już nie istnieje. Odśwież listę.');
    const target = join(entry.parentReal, newName);
    const existing = await lstatOrNull(target);
    if (existing) {
      // A case-only rename on a case-insensitive volume "exists" already: go through a temporary name.
      if (newName.toLowerCase() === entry.name.toLowerCase() && await sameFile(entry.real, target)) {
        const temporary = join(entry.parentReal, `.mc-rename-${randomUUID()}`);
        await rename(entry.real, temporary);
        try { await rename(temporary, target); }
        catch (error) { await rename(temporary, entry.real).catch(() => undefined); throw error; }
        return { ok: true, from: entry.rel, to };
      }
      throw new OpError('Element o takiej nazwie już istnieje.');
    }
    await rename(entry.real, target);
    return { ok: true, from: entry.rel, to };
  } catch (error) { return { ok: false, error: opMessage(error) }; }
}

// ---------- create ----------

export async function createProjectEntry(projectRoot: string, directory: string, name: string, kind: 'file' | 'directory', options: Pick<FileOpOptions, 'platform'> = {}): Promise<CreateResult> {
  try {
    const ctx = await context(projectRoot);
    const folder = await folderOf(ctx, directory);
    if (typeof name !== 'string') throw new OpError('Nazwa nie może być pusta.');
    const invalid = validateEntryName(name, platformOf(options));
    if (invalid) throw new OpError(invalid);
    const target = join(folder.real, name);
    if (await lstatOrNull(target)) throw new OpError('Element o takiej nazwie już istnieje.');
    if (kind === 'directory') await mkdir(target);
    else await (await open(target, 'wx')).close();
    return { ok: true, path: joinPath(folder.rel, name) };
  } catch (error) { return { ok: false, error: opMessage(error) }; }
}

// ---------- delete (to the trash only) ----------

export async function deleteProjectEntries(projectRoot: string, paths: string[], options: Pick<FileOpOptions, 'trash'>): Promise<DeleteResult> {
  try {
    if (!Array.isArray(paths) || !paths.length) throw new OpError('Nie wybrano żadnych elementów.');
    if (!validPathList(paths)) throw new OpError('Zbyt wiele elementów lub zbyt długa ścieżka.');
    const ctx = await context(projectRoot);
    const entries: Entry[] = [];
    for (const path of topLevelPaths(paths.map((p) => toPosix(p)))) entries.push(await entryOf(ctx, path));
    const trashed: string[] = [];
    const failed: FileOpFailure[] = [];
    for (const entry of entries) {
      try {
        if (!await lstatOrNull(entry.real)) throw new OpError('Plik lub folder już nie istnieje. Odśwież listę.');
        await options.trash(entry.real);
        trashed.push(entry.rel);
      } catch (error) { failed.push({ path: entry.rel, error: opMessage(error) }); }
    }
    return { ok: true, trashed, failed };
  } catch (error) { return { ok: false, error: opMessage(error) }; }
}

// ---------- copy / move ----------

interface Plan { entry: Entry; directory: boolean; link: boolean; target: string; targetRel: string; same: boolean }

async function measure(paths: string[], limits: { bytes: number; entries: number }): Promise<{ entries: number; bytes: number; exceeded: boolean }> {
  let entries = 0, bytes = 0;
  const walk = async (path: string): Promise<boolean> => {
    const info = await lstatOrNull(path);
    if (!info) return false;
    entries++;
    if (info.isFile()) bytes += info.size;
    if (entries > limits.entries || bytes > limits.bytes) return true;
    if (info.isDirectory()) {
      let names: string[] = [];
      try { names = await readdir(path); } catch { return false; }
      for (const name of names) if (await walk(join(path, name))) return true;
    }
    return false;
  };
  for (const path of paths) if (await walk(path)) return { entries, bytes, exceeded: true };
  return { entries, bytes, exceeded: false };
}

class Counter {
  entries = 0; bytes = 0; notes: string[] = []; private last = 0;
  constructor(readonly options: FileOpOptions) {}
  tick(): void {
    if (this.options.signal?.aborted) throw new OpError('Operacja została anulowana.');
    const now = Date.now();
    if (this.options.onProgress && now - this.last > 120) { this.last = now; this.options.onProgress({ entries: this.entries, bytes: this.bytes }); }
  }
}

async function copyTree(source: string, target: string, counter: Counter): Promise<void> {
  counter.tick();
  const info = await lstat(source);
  counter.entries++;
  if (info.isSymbolicLink()) {
    // Links are copied as links (never followed); where that is not allowed the link is skipped with a note.
    try {
      const destination = await readlink(source);
      let type: 'file' | 'dir' | 'junction' | undefined;
      if (process.platform === 'win32') type = (await stat(source).catch(() => null))?.isDirectory() ? 'junction' : 'file';
      await (counter.options.hooks?.symlink ?? symlink)(destination, target, type);
    } catch { counter.notes.push(basename(source)); }
    return;
  }
  if (info.isDirectory()) {
    await mkdir(target, { mode: info.mode & 0o777 });
    for (const name of await readdir(source)) await copyTree(join(source, name), join(target, name), counter);
    await utimes(target, info.atime, info.mtime).catch(() => undefined);
    return;
  }
  if (!info.isFile()) { counter.notes.push(basename(source)); return; }
  await copyFile(source, target, constants.COPYFILE_EXCL);
  counter.bytes += info.size;
  await utimes(target, info.atime, info.mtime).catch(() => undefined);
}

async function freeName(dir: string, name: string, directory: boolean, claimed: Set<string>): Promise<string> {
  for (let n = 1; n < 10000; n++) {
    const candidate = copyName(name, n, directory);
    if (!claimed.has(norm(candidate)) && !await lstatOrNull(join(dir, candidate))) return candidate;
  }
  throw new OpError('Element o takiej nazwie już istnieje.');
}

export async function transferProjectEntries(projectRoot: string, request: FileOpRequest, options: FileOpOptions): Promise<FileOpResult> {
  try {
    if (!request || typeof request !== 'object' || !Array.isArray(request.paths) || !request.paths.length) throw new OpError('Nie wybrano żadnych elementów.');
    if (!validPathList(request.paths)) throw new OpError('Zbyt wiele elementów lub zbyt długa ścieżka.');
    if (request.kind !== 'move' && request.kind !== 'copy') throw new OpError('Nieznana operacja.');
    const policy = request.conflict ?? 'ask';
    if (policy !== 'ask' && policy !== 'skip' && policy !== 'keepBoth' && policy !== 'replace') throw new OpError('Nieznana operacja.');
    const copying = request.kind === 'copy';
    const ctx = await context(projectRoot);
    const destination = await folderOf(ctx, request.destination ?? '');
    const plans: Plan[] = [];
    const conflicts: FileConflict[] = [];
    const claimed = new Set<string>();
    for (const path of topLevelPaths(request.paths.map((p) => toPosix(p)))) {
      const entry = await entryOf(ctx, path);
      const info = await lstatOrNull(entry.real);
      if (!info) throw new OpError('Plik lub folder już nie istnieje. Odśwież listę.');
      const directory = info.isDirectory();
      if (directory && sameOrInside(entry.real, destination.real)) throw new OpError('Nie można przenieść folderu do niego samego ani do jego podfolderu.');
      const target = join(destination.real, entry.name);
      const same = norm(target) === norm(entry.real);
      plans.push({ entry, directory, link: info.isSymbolicLink(), target, targetRel: joinPath(destination.rel, entry.name), same });
      const internal = claimed.has(norm(entry.name));
      if (!same && (internal || await lstatOrNull(target))) conflicts.push({ path: joinPath(destination.rel, entry.name), name: entry.name, directory, ...(internal ? { internal: true } : {}) });
      claimed.add(norm(entry.name));
    }
    if (conflicts.length && policy === 'ask') return { ok: false, code: 'conflict', error: 'Element o takiej nazwie już istnieje.', conflicts };
    if (copying && !request.force) {
      const limits = options.limits ?? { bytes: LARGE_COPY_BYTES, entries: LARGE_COPY_ENTRIES };
      const size = await measure(plans.map((plan) => plan.entry.real), limits);
      if (size.exceeded) return { ok: false, code: 'large', error: 'Kopiowanie jest bardzo duże.', entries: size.entries, bytes: size.bytes };
    }

    const done: FileMoveRecord[] = [];
    const skipped: string[] = [];
    const failed: FileOpFailure[] = [];
    const counter = new Counter(options);
    const taken = new Set<string>();
    const replaced: string[] = [];
    let cancelled = false;
    for (const plan of plans) {
      let target = plan.target;
      let targetRel = plan.targetRel;
      let created = false;
      try {
        counter.tick();
        if (plan.same) {
          if (!copying) { taken.add(norm(plan.entry.name)); skipped.push(plan.entry.rel); continue; }
          const name = await freeName(destination.real, plan.entry.name, plan.directory, taken);
          target = join(destination.real, name); targetRel = joinPath(destination.rel, name);
        } else if (taken.has(norm(plan.entry.name)) || await lstatOrNull(target)) {
          if (policy === 'skip') { skipped.push(plan.entry.rel); continue; }
          // An item that this very operation produced is never replaced: the second one gets a free name instead.
          if (policy === 'keepBoth' || taken.has(norm(plan.entry.name))) {
            const name = await freeName(destination.real, plan.entry.name, plan.directory, taken);
            target = join(destination.real, name); targetRel = joinPath(destination.rel, name);
          } else {
            // Replace: the old item goes to the trash first (never a permanent delete).
            if (sameOrInside(target, plan.entry.real)) throw new OpError('Nie można zastąpić folderu, który zawiera przenoszony element.');
            if (!await lstatOrNull(target)) throw new OpError('Element o takiej nazwie już istnieje.');
            await options.trash(target);
            replaced.push(targetRel);
          }
        }
        taken.add(norm(basename(target)));
        if (copying) {
          created = true;
          await copyTree(plan.entry.real, target, counter);
        } else {
          try { await (options.hooks?.rename ?? rename)(plan.entry.real, target); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            created = true;
            const notes = counter.notes.length;
            await copyTree(plan.entry.real, target, counter);
            if (counter.notes.length > notes) {
              // Something could not be copied: removing the source would destroy it. Keep it and undo the copy.
              counter.notes.length = notes;
              throw new OpError('Nie można przenieść: część elementów (linki lub pliki specjalne) nie daje się skopiować.');
            }
            created = false;
            await rm(plan.entry.real, { recursive: true, force: true });
          }
        }
        created = false;
        done.push({ from: plan.entry.rel, to: targetRel });
      } catch (error) {
        // A half-made copy is our own leftovers: remove them so no partial tree stays behind.
        if (created) await rm(target, { recursive: true, force: true }).catch(() => undefined);
        if (options.signal?.aborted) { cancelled = true; break; }
        failed.push({ path: plan.entry.rel, error: opMessage(error) });
      }
    }
    options.onProgress?.({ entries: counter.entries, bytes: counter.bytes });
    return { ok: true, done, skipped, failed, notes: counter.notes, cancelled, replaced };
  } catch (error) { return { ok: false, error: opMessage(error) }; }
}
