// Per-cell files in the data folder: the Claude hook settings (hooks/claude-<cell>.json, they carry the hook token), the MCP
// config (mcp/<cell>.json) and the startup prompt (prompts/<cell>.txt, the whole first task in plain text).
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
