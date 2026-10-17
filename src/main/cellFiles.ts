// Per-cell files in the data folder: the Claude hook settings (hooks/claude-<cell>.json, they carry the hook token), the MCP
// config (mcp/<cell>.json, Claude cells only, it carries the cell's MCP token) and the startup prompt (prompts/<cell>.txt, the whole first task in plain text).
import { readdir, rm } from 'fs/promises';
import { join } from 'path';

export interface CellFileDirs { hooks: string; prompts: string; mcp: string }

const CELL_ID = /^[\w-]{1,64}$/;

/** The cell a file in one of the folders belongs to, or null for anything else (never touched). */
export function cellOfFile(kind: keyof CellFileDirs, name: string): string | null {
  const match = kind === 'hooks' ? /^claude-(.+)\.json$/.exec(name) : kind === 'mcp' ? /^(.+)\.json$/.exec(name) : /^(.+)\.txt$/.exec(name);
  return match && CELL_ID.test(match[1]) ? match[1] : null;
}

const fileOf = (dirs: CellFileDirs, kind: keyof CellFileDirs, cellId: string): string =>
  join(dirs[kind], kind === 'hooks' ? `claude-${cellId}.json` : kind === 'mcp' ? `${cellId}.json` : `${cellId}.txt`);

/**
 * Startup prompt files (one name per spawn) of each cell's processes, oldest first; null for a spawn without one. An exit or a
 * failed spawn always belongs to the oldest process of the cell, so it removes that one's file and never a respawn's new prompt.
 */
export class PromptFiles {
  private readonly files = new Map<string, Array<string | null>>();
  constructor(private readonly remove: (file: string) => void) {}
  queue(cellId: string, file: string | null): void {
    this.files.set(cellId, [...(this.files.get(cellId) ?? []), file]);
  }
  release(cellId: string): void {
    const queue = this.files.get(cellId);
    if (!queue?.length) return;
    const file = queue.shift();
    if (!queue.length) this.files.delete(cellId);
    if (file) this.remove(file);
  }
  /** The terminal process is gone: none of its processes will report an exit any more. */
  releaseAll(): void {
    for (const cellId of [...this.files.keys()]) while (this.files.has(cellId)) this.release(cellId);
  }
}

/** Removes the cell's files of the given kinds (missing ones are fine). */
export async function removeCellFiles(dirs: CellFileDirs, cellId: string, kinds: Array<keyof CellFileDirs> = ['hooks', 'prompts', 'mcp']): Promise<void> {
  if (!CELL_ID.test(cellId)) return;
  await Promise.all(kinds.map((kind) => rm(fileOf(dirs, kind, cellId), { force: true }).catch(() => undefined)));
}

/**
 * At startup, before any cell runs: hook and MCP files of cells that no longer exist (in any grid or the archive) go, and every
 * startup prompt (a spawn writes its prompt again). Returns how many were removed.
 */
export async function pruneCellFiles(dirs: CellFileDirs, keep: ReadonlySet<string>): Promise<number> {
  let removed = 0;
  for (const kind of ['hooks', 'prompts', 'mcp'] as const) {
    let names: string[];
    try { names = await readdir(dirs[kind]); } catch { continue; }
    for (const name of names) {
      const cellId = cellOfFile(kind, name);
      if (!cellId || (kind !== 'prompts' && keep.has(cellId))) continue;
      try { await rm(join(dirs[kind], name), { force: true }); removed++; } catch { /* in use: next start */ }
    }
  }
  return removed;
}
