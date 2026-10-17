import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { cellOfFile, pruneCellFiles, removeCellFiles } from '../src/main/cellFiles';

const roots: string[] = [];
function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'mc-cellfiles-'));
  roots.push(root);
  const d = { hooks: join(root, 'hooks'), prompts: join(root, 'prompts'), mcp: join(root, 'mcp') };
  for (const dir of Object.values(d)) mkdirSync(dir);
  return d;
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('per-cell files', () => {
  it('names only the files the app writes', () => {
    expect(cellOfFile('hooks', 'claude-abc_1.json')).toBe('abc_1');
    expect(cellOfFile('hooks', 'hook-debug.log')).toBeNull();
    expect(cellOfFile('mcp', 'abc.json')).toBe('abc');
    expect(cellOfFile('prompts', 'abc.txt')).toBe('abc');
    expect(cellOfFile('prompts', '..\\evil.txt')).toBeNull();
  });

  it('at startup removes files of cells that are gone and every old startup prompt, and leaves other files alone', async () => {
    const d = dirs();
    for (const id of ['kept', 'gone']) {
      writeFileSync(join(d.hooks, `claude-${id}.json`), '{}');
      writeFileSync(join(d.mcp, `${id}.json`), '{}');
      writeFileSync(join(d.prompts, `${id}.txt`), 'secret task');
    }
    writeFileSync(join(d.hooks, 'notes.txt'), 'x');
    expect(await pruneCellFiles(d, new Set(['kept']))).toBe(4);
    expect(readdirSync(d.hooks).sort()).toEqual(['claude-kept.json', 'notes.txt']);
    expect(readdirSync(d.mcp)).toEqual(['kept.json']);
    expect(readdirSync(d.prompts)).toEqual([]);
  });

  it('removes one cell\'s files on request and ignores a missing folder', async () => {
    const d = dirs();
    writeFileSync(join(d.prompts, 'c1.txt'), 'task');
    writeFileSync(join(d.hooks, 'claude-c1.json'), '{}');
    await removeCellFiles(d, 'c1', ['prompts']);
    expect(existsSync(join(d.prompts, 'c1.txt'))).toBe(false);
    expect(existsSync(join(d.hooks, 'claude-c1.json'))).toBe(true);
    await removeCellFiles(d, 'c1');
    expect(existsSync(join(d.hooks, 'claude-c1.json'))).toBe(false);
    rmSync(d.mcp, { recursive: true });
    await expect(pruneCellFiles(d, new Set())).resolves.toBe(0);
  });
});
