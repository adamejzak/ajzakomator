// Index of past Claude Code / Codex conversations for a project folder.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { open, readdir, stat } from 'fs/promises';
import { join, sep } from 'path';
import type { SessionInfo } from '../shared/types';
import { normalizeProjectPath } from '../shared/platform';

export type { SessionInfo };


const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_CODEX_FILES = 600;

/** Claude stores sessions under ~/.claude/projects/<path with every non-alphanumeric char → '-'>. */
export const claudeProjectDirName = (projectPath: string) => projectPath.replace(/[^a-zA-Z0-9]/g, '-');

const normPath = normalizeProjectPath;

function readSlice(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial line at a slice boundary or garbage - skip
    }
  }
  return out;
}

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 140);
const isInjected = (s: string) => /^\s*(<|# AGENTS\.md)/.test(s);

// ── Claude ──────────────────────────────────────────────────────────────────

function claudeText(entry: any): string | null {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const c = entry.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '';
  return text && !isInjected(text) ? text : null;
}

interface FileStat { size: number; mtimeMs: number; birthtimeMs: number }

async function readSliceAsync(file: string, start: number, length: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Parses a Claude session file from its head (and tail when the file is larger than the head slice). */
function parseClaudeSession(headText: string, tailText: string, st: FileStat): SessionInfo | null {
  const head = parseLines(headText);
  const tail = parseLines(tailText);
  const all = [...head, ...tail];
  const id = all.find((e) => typeof e?.sessionId === 'string')?.sessionId;
  if (!id) return null;
  const title = [...all].reverse().find((e) => e?.type === 'ai-title' && e.aiTitle)?.aiTitle ?? head.map(claudeText).find(Boolean);
  if (!title) return null; // sessions without any user prompt are noise
  const firstTs = head.find((e) => e?.timestamp)?.timestamp;
  return {
    cli: 'claude',
    id,
    cwd: head.find((e) => e?.cwd)?.cwd ?? '',
    title: clip(title),
    startedAt: firstTs ? Date.parse(firstTs) : st.birthtimeMs,
    updatedAt: st.mtimeMs,
  };
}

const tailStart = (st: FileStat) => Math.max(0, st.size - TAIL_BYTES);

function readClaudeSession(file: string, st: FileStat): SessionInfo | null {
  claudeParses++;
  const tail = st.size > HEAD_BYTES ? readSlice(file, tailStart(st), TAIL_BYTES) : '';
  return parseClaudeSession(readSlice(file, 0, HEAD_BYTES), tail, st);
}

async function readClaudeSessionAsync(file: string, st: FileStat): Promise<SessionInfo | null> {
  claudeParses++;
  const [head, tail] = await Promise.all([
    readSliceAsync(file, 0, HEAD_BYTES),
    st.size > HEAD_BYTES ? readSliceAsync(file, tailStart(st), TAIL_BYTES) : Promise.resolve(''),
  ]);
  return parseClaudeSession(head, tail, st);
}

// Parsed sessions keyed by file; reused while mtime and size are unchanged. Pruned per listed folder.
const claudeCache = new Map<string, { mtimeMs: number; size: number; info: SessionInfo | null }>();
let claudeParses = 0;

/** Test hook: how many files were parsed since start and how many are cached. */
export const claudeCacheStats = () => ({ parses: claudeParses, cached: claudeCache.size });
export const clearClaudeCache = () => { claudeCache.clear(); claudeParses = 0; };

const claudeDir = (home: string, projectPath: string) => join(home, '.claude', 'projects', claudeProjectDirName(projectPath));
const cachedClaude = (file: string, st: FileStat) => {
  const hit = claudeCache.get(file);
  return hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit : undefined;
};

/** Drops cache entries of `dir` whose files were not seen in the latest listing. */
function pruneClaudeCache(dir: string, seen: Set<string>): void {
  const prefix = dir + sep;
  for (const key of claudeCache.keys()) if (key.startsWith(prefix) && !seen.has(key)) claudeCache.delete(key);
}

export function listClaudeSessions(home: string, projectPath: string): SessionInfo[] {
  const dir = claudeDir(home, projectPath);
  if (!existsSync(dir)) {
    pruneClaudeCache(dir, new Set());
    return [];
  }
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = join(dir, f);
    try {
      const st = statSync(file);
      seen.add(file);
      let entry = cachedClaude(file, st);
      if (!entry) {
        entry = { mtimeMs: st.mtimeMs, size: st.size, info: readClaudeSession(file, st) };
        claudeCache.set(file, entry);
      }
      if (entry.info) out.push(entry.info);
    } catch {
      // unreadable file - skip
    }
  }
  pruneClaudeCache(dir, seen);
  return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const CONCURRENCY = 4;

/** Same result as listClaudeSessions, but never blocks the event loop on file IO. */
export async function listClaudeSessionsAsync(home: string, projectPath: string): Promise<SessionInfo[]> {
  const dir = claudeDir(home, projectPath);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    pruneClaudeCache(dir, new Set());
    return [];
  }
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const file = join(dir, names[next++]);
      try {
        const st = await stat(file);
        seen.add(file);
        let entry = cachedClaude(file, st);
        if (!entry) {
          entry = { mtimeMs: st.mtimeMs, size: st.size, info: await readClaudeSessionAsync(file, st) };
          claudeCache.set(file, entry);
        }
        if (entry.info) out.push(entry.info);
      } catch {
        // unreadable file - skip
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  pruneClaudeCache(dir, seen);
  return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── Codex ───────────────────────────────────────────────────────────────────

interface CodexMeta {
  id: string;
  cwd: string;
  timestamp?: string;
}

// Parsed heads keyed by path; reused while the file's mtime is unchanged.
const metaCache = new Map<string, { mtimeMs: number; meta: CodexMeta | null; title: string | null | undefined }>();

function cachedCodex(file: string): { mtimeMs: number; meta: CodexMeta | null; entry: { title: string | null | undefined } } {
  const mtimeMs = statSync(file).mtimeMs;
  let entry = metaCache.get(file);
  if (!entry || entry.mtimeMs !== mtimeMs) {
    entry = { mtimeMs, meta: codexMeta(file), title: undefined };
    metaCache.set(file, entry);
  }
  return { mtimeMs, meta: entry.meta, entry };
}

function codexMeta(file: string): CodexMeta | null {
  // The first line (session_meta) carries the id and cwd; it can be tens of KB.
  for (let size = 64 * 1024; size <= 1024 * 1024; size *= 4) {
    const text = readSlice(file, 0, size);
    const nl = text.indexOf('\n');
    if (nl < 0 && text.length === size) continue;
    try {
      const first = JSON.parse(nl < 0 ? text : text.slice(0, nl));
      if (first?.type !== 'session_meta') return null;
      const p = first.payload ?? {};
      const id = p.id ?? p.session_id;
      return id ? { id, cwd: p.cwd ?? '', timestamp: p.timestamp } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function codexTitle(file: string): string | null {
  for (const e of parseLines(readSlice(file, 0, HEAD_BYTES))) {
    if (e?.type === 'event_msg' && e.payload?.type === 'user_message' && typeof e.payload.message === 'string' && !isInjected(e.payload.message))
      return e.payload.message;
    if (e?.type === 'response_item' && e.payload?.type === 'message' && e.payload.role === 'user' && Array.isArray(e.payload.content)) {
      const text = e.payload.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).find((t: string) => t && !isInjected(t));
      if (text) return text;
    }
  }
  return null;
}

function codexFiles(home: string): string[] {
  const root = join(home, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root);
  // Paths are YYYY/MM/DD/rollout-<timestamp>-…, so lexical order is chronological.
  return files.sort().reverse().slice(0, MAX_CODEX_FILES);
}

export function listCodexSessions(home: string, projectPath: string): SessionInfo[] {
  const want = normPath(projectPath);
  const out: SessionInfo[] = [];
  for (const file of codexFiles(home)) {
    try {
      const { meta, entry, mtimeMs } = cachedCodex(file);
      if (!meta || normPath(meta.cwd) !== want) continue;
      if (entry.title === undefined) entry.title = codexTitle(file);
      const title = entry.title;
      if (!title) continue;
      const st = { mtimeMs, birthtimeMs: mtimeMs };
      out.push({
        cli: 'codex',
        id: meta.id,
        cwd: meta.cwd,
        title: clip(title),
        startedAt: meta.timestamp ? Date.parse(meta.timestamp) : st.birthtimeMs,
        updatedAt: st.mtimeMs,
      });
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Codex session for `cwd` written within the last `windowMs` and not bound elsewhere - called right
 * after a Codex cell finished a turn, when its rollout file was just appended to.
 */
export function findRecentCodexSession(home: string, cwd: string, windowMs: number, exclude: Set<string>): string | null {
  const want = normPath(cwd);
  const since = Date.now() - windowMs;
  let best: { id: string; mtimeMs: number } | null = null;
  for (const file of codexFiles(home).slice(0, 80)) {
    try {
      const { meta, mtimeMs } = cachedCodex(file);
      if (mtimeMs < since || !meta || exclude.has(meta.id) || normPath(meta.cwd) !== want) continue;
      if (!best || mtimeMs > best.mtimeMs) best = { id: meta.id, mtimeMs };
    } catch {
      // skip
    }
  }
  return best?.id ?? null;
}

export function listSessions(home: string, projectPath: string): SessionInfo[] {
  return [...listClaudeSessions(home, projectPath), ...listCodexSessions(home, projectPath)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

/** Non-blocking variant for the IPC handler (Codex listing is cached and only stats files). */
export async function listSessionsAsync(home: string, projectPath: string): Promise<SessionInfo[]> {
  const claude = await listClaudeSessionsAsync(home, projectPath);
  return [...claude, ...listCodexSessions(home, projectPath)].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
