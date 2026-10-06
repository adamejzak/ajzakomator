// Index of past Claude Code / Codex conversations for a project folder.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { join } from 'path';
import type { SessionInfo } from '../shared/types';

export type { SessionInfo };


const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_CODEX_FILES = 600;

/** Claude stores sessions under ~/.claude/projects/<path with every non-alphanumeric char → '-'>. */
export const claudeProjectDirName = (projectPath: string) => projectPath.replace(/[^a-zA-Z0-9]/g, '-');

const normPath = (p: string) => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

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
      // partial line at a slice boundary or garbage — skip
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

function readClaudeSession(file: string): SessionInfo | null {
  const st = statSync(file);
  const head = parseLines(readSlice(file, 0, HEAD_BYTES));
  const tail = st.size > HEAD_BYTES ? parseLines(readSlice(file, Math.max(0, st.size - TAIL_BYTES), TAIL_BYTES)) : [];
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

export function listClaudeSessions(home: string, projectPath: string): SessionInfo[] {
  const dir = join(home, '.claude', 'projects', claudeProjectDirName(projectPath));
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const s = readClaudeSession(join(dir, f));
      if (s) out.push(s);
    } catch {
      // unreadable file — skip
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Codex ───────────────────────────────────────────────────────────────────

function codexMeta(file: string): { id: string; cwd: string; timestamp?: string } | null {
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
      const meta = codexMeta(file);
      if (!meta || normPath(meta.cwd) !== want) continue;
      const title = codexTitle(file);
      if (!title) continue;
      const st = statSync(file);
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
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Newest Codex session for `cwd` created after `sinceMs` that isn't bound to another cell yet. */
export function findNewCodexSession(home: string, cwd: string, sinceMs: number, exclude: Set<string>): string | null {
  const want = normPath(cwd);
  for (const file of codexFiles(home).slice(0, 50)) {
    try {
      if (statSync(file).birthtimeMs < sinceMs - 2000) continue;
      const meta = codexMeta(file);
      if (meta && normPath(meta.cwd) === want && !exclude.has(meta.id)) return meta.id;
    } catch {
      // skip
    }
  }
  return null;
}

export function listSessions(home: string, projectPath: string): SessionInfo[] {
  return [...listClaudeSessions(home, projectPath), ...listCodexSessions(home, projectPath)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}
