import { open, readdir } from 'fs/promises';
import { join } from 'path';
import type { UsageWindow } from '../../shared/usage';
import { parseCodexPlan, parseCodexRateLimits } from './parse';

const TAIL_BYTES = 256 * 1024;
const NEWEST_FILES = 8;

async function readTail(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A tail read may start in the middle of a line.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { await file.close(); }
}

/** The newest `rate_limits` event with usable windows from Codex session logs; only file tails are read. */
export async function readCodexLog(codexHome: string): Promise<{ windows: UsageWindow[]; plan?: string; at: number } | null> {
  const sessions = join(codexHome, 'sessions');
  let names: string[];
  try { names = (await readdir(sessions, { recursive: true })).map(String); } catch { return null; }
  // Paths start with YYYY/MM/DD and file names with a timestamp, so reverse order is newest first.
  const files = names.filter((name) => name.endsWith('.jsonl')).sort().reverse().slice(0, NEWEST_FILES);
  for (const name of files) {
    let text: string;
    try { text = await readTail(join(sessions, name)); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let event: { timestamp?: unknown; payload?: unknown } & Record<string, unknown>;
      try { event = JSON.parse(lines[i]); } catch { continue; }
      const body = event.payload ?? event;
      const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
      const windows = parseCodexRateLimits(body, Number.isFinite(at) ? at : Date.now());
      if (windows) return { windows, plan: parseCodexPlan((body as Record<string, unknown>).rate_limits), at: Number.isFinite(at) ? at : Date.now() };
    }
  }
  return null;
}
