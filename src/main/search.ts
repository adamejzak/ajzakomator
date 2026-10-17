import { open, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import {
  buildPattern, compileGlobs, IGNORED_FOLDERS, MAX_MATCHES, replaceInText, searchText,
  type ReplaceFileResult, type ReplaceRequest, type ReplaceResult, type SearchFile, type SearchOptions, type SearchResult,
} from '../shared/search';
import { PREVIEW_BYTES, readProjectFile, writeProjectFile } from './files';

const MAX_FILES = 20000;
const TIME_BUDGET_MS = 10000;

/** Decoded text of a small text file, or null for binary, unreadable and oversized files. */
async function readSearchableText(path: string): Promise<{ text: string } | 'large' | null> {
  let file;
  try { file = await open(path, 'r'); } catch { return null; }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    if (stat.size > PREVIEW_BYTES) return 'large';
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, stat.size, 0);
    const data = buffer.subarray(0, bytesRead);
    const utf16 = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : null;
    if (!utf16 && data.includes(0)) return null;
    try {
      const text = new TextDecoder(utf16 ?? 'utf-8', { fatal: true }).decode(data);
      return /[\x00-\x08\x0e-\x1f]/.test(text) ? null : { text };
    } catch { return null; }
  } catch { return null; }
  finally { await file.close(); }
}

/** One collator for every comparison (localeCompare with options builds one per call). */
const collator = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });
/** Files of one folder read at the same time; results are still taken in name order. */
const READERS = 6;

/** Results of a search that a newer one replaced (nobody shows them). */
const cancelled = (): SearchResult => ({ ok: true, files: [], matches: 0, scanned: 0, skipped: 0, truncated: true });

/**
 * Searches every small text file of the project; symlinks are never followed. `signal` stops a search that a newer one
 * replaced, between files.
 */
export async function searchProject(root: string, options: SearchOptions, now: () => number = Date.now, signal?: AbortSignal): Promise<SearchResult> {
  const pattern = buildPattern(options);
  if ('error' in pattern) return pattern.error ? { ok: false, error: `Nieprawidłowe wyrażenie regularne: ${pattern.error}` } : { ok: true, files: [], matches: 0, scanned: 0, skipped: 0, truncated: false };
  const include = compileGlobs(options.include);
  const exclude = compileGlobs(options.exclude);
  const base = resolve(root);
  const files: SearchFile[] = [];
  let matches = 0, scanned = 0, skipped = 0, truncated = false;
  const started = now();
  const stack: string[] = [''];
  while (stack.length && !truncated) {
    if (signal?.aborted) return cancelled();
    const directory = stack.pop()!;
    let items;
    try { items = await readdir(join(base, directory), { withFileTypes: true }); } catch { continue; }
    items.sort((a, b) => collator.compare(a.name, b.name));
    const folders: string[] = [];
    const candidates: string[] = [];
    for (const item of items) {
      const path = directory ? `${directory}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if ((options.includeIgnored || !IGNORED_FOLDERS.has(item.name)) && !exclude?.(`${path}/`)) folders.push(path);
        continue;
      }
      if (!item.isFile() || (include && !include(path)) || exclude?.(path)) continue;
      candidates.push(path);
    }
    // A few readers fetch the folder's files ahead; the budget is checked before each file is started, in name order.
    const reads: Array<Promise<Awaited<ReturnType<typeof readSearchableText>>> | undefined> = [];
    const before = scanned;
    let queued = 0;
    const start = (): boolean => {
      if (queued >= candidates.length || signal?.aborted) return false;
      if (before + queued >= MAX_FILES || now() - started > TIME_BUDGET_MS) return false;
      reads[queued] = readSearchableText(join(base, candidates[queued]));
      queued++;
      return true;
    };
    for (let i = 0; i < READERS && start(); i++) { /* fill the window */ }
    for (let i = 0; i < candidates.length; i++) {
      const pending = reads[i];
      if (!pending) {
        if (signal?.aborted) return cancelled();
        truncated = true;
        break;
      }
      const read = await pending;
      reads[i] = undefined;
      start();
      scanned++;
      if (read === null || read === 'large') { skipped++; continue; }
      const found = searchText(read.text, pattern.regex, MAX_MATCHES - matches);
      if (found.matches.length) { files.push({ path: candidates[i], matches: found.matches }); matches += found.matches.length; }
      if (found.truncated || matches >= MAX_MATCHES) { truncated = true; break; }
    }
    // Let reads that were started ahead finish (their handles close) before the result is returned.
    await Promise.all(reads.filter(Boolean));
    if (signal?.aborted) return cancelled();
    // Depth-first in name order: push in reverse so the first folder is searched first.
    for (const folder of folders.reverse()) stack.push(folder);
  }
  files.sort((a, b) => collator.compare(a.path, b.path));
  return { ok: true, files, matches, scanned, skipped, truncated };
}

/**
 * Replaces in one match, one file or every matching file. Every file is read fresh and written back only if it
 * did not change in between; line endings and byte order marks are preserved by the writer.
 */
export async function replaceInProject(root: string, request: ReplaceRequest): Promise<ReplaceResult> {
  const { options, replacement, scope } = request;
  if (typeof replacement !== 'string') return { ok: false, error: 'Nieprawidłowy tekst zamiany.' };
  const pattern = buildPattern(options);
  if ('error' in pattern) return { ok: false, error: pattern.error ? `Nieprawidłowe wyrażenie regularne: ${pattern.error}` : 'Wpisz, czego szukać.' };
  let paths: string[];
  if (scope.kind === 'all') {
    const found = await searchProject(root, options);
    if (!found.ok) return found;
    paths = found.files.map((file) => file.path);
  } else paths = [scope.path];

  const results: ReplaceFileResult[] = [];
  let replaced = 0;
  for (const path of paths) {
    const read = await readProjectFile(root, path);
    if (read.kind !== 'text' || read.truncated) {
      results.push({ path, replaced: 0, error: read.kind === 'error' ? read.message : 'Plik jest binarny albo zbyt duży do bezpiecznej zamiany.' });
      continue;
    }
    const edit = replaceInText(read.text, {
      regex: pattern.regex, replacement, expand: !!options.regex,
      only: scope.kind === 'match' ? { line: scope.line, column: scope.column, text: scope.text } : undefined,
    });
    if (!edit.count) {
      results.push({ path, replaced: 0, ...(scope.kind === 'match' ? { error: 'Plik zmienił się od wyszukiwania. Wyszukaj ponownie.' } : {}) });
      continue;
    }
    const written = await writeProjectFile(root, path, edit.text, read.text);
    if (written.ok) { results.push({ path, replaced: edit.count }); replaced += edit.count; }
    else results.push({ path, replaced: 0, error: written.error });
  }
  return { ok: true, replaced, files: results };
}
