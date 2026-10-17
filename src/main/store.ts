// state.json persistence: atomic writes (retried on Windows file locks), debounced saves that keep the state on failure, .bak fallback.
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { defaultState, normalizeState } from '../shared/state';
import type { AppState } from '../shared/types';
import type { AppPlatform } from '../shared/platform';
import { atomicWriteFileSync, isTransientFsError, sleepSync } from './atomicWrite';
import { backupPath } from './ssh/files';

const FILE = 'state.json';
/** The .bak copy is refreshed by a save at most this often (it is the fallback for a damaged state.json). */
export const BAK_REFRESH_MS = 60 * 60_000;

type ReadResult = { kind: 'ok'; state: AppState } | { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'corrupt' };

function readState(path: string, platform: AppPlatform): ReadResult {
  if (!existsSync(path)) return { kind: 'missing' };
  let text: string | undefined;
  // A file held by a scanner for a moment is read again before it counts as unreadable.
  for (let attempt = 0; text === undefined; attempt++) {
    try { text = readFileSync(path, 'utf8'); } catch (error) {
      if (attempt >= 4 || !isTransientFsError(error)) return { kind: 'unreadable' };
      sleepSync(25 * 2 ** attempt);
    }
  }
  try {
    const state = normalizeState(JSON.parse(text), platform);
    return state ? { kind: 'ok', state } : { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

export interface LoadOptions {
  /** Called once with what went wrong (a kept backup, a failed .bak copy); never with secrets. */
  log?: (message: string) => void;
}

export function loadState(dir: string, platform: AppPlatform = 'win32', options: LoadOptions = {}): AppState {
  mkdirSync(dir, { recursive: true });
  const main = join(dir, FILE);
  const bak = join(dir, FILE + '.bak');
  const read = readState(main, platform);
  if (read.kind === 'ok') {
    // The .bak copy is a convenience: a file held by antivirus or a backup tool must never stop the app from starting.
    try { atomicWriteFileSync(bak, readFileSync(main)); } catch (error) { options.log?.(`state.json.bak not refreshed: ${String((error as Error)?.message ?? error)}`); }
    return read.state;
  }
  // An unparsable state.json is kept next to it (never overwritten by the next save), so it can still be recovered by hand.
  if (read.kind === 'corrupt') {
    try {
      const kept = backupPath(main);
      renameSync(main, kept);
      options.log?.(`state.json could not be read and was kept as ${kept}`);
    } catch (error) { options.log?.(`state.json could not be read nor kept: ${String((error as Error)?.message ?? error)}`); }
  }
  const fallback = readState(bak, platform);
  return fallback.kind === 'ok' ? fallback.state : defaultState(platform);
}

/** The text written to state.json: compact (no indent), it is rewritten on every change. */
export const serializeState = (state: AppState): string => JSON.stringify(state);

export function writeStateNow(dir: string, state: AppState): void {
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, FILE), serializeState(state));
}

export interface SaverOptions {
  debounceMs?: number;
  /** Reports a failed save (once per failure streak) and the recovery; never throws. */
  log?: (message: string) => void;
  /** Test seams. */
  write?: (dir: string, state: AppState) => void;
  writeBak?: (dir: string, state: AppState) => void;
  now?: () => number;
}

/** Waits before the next try after a failed save: 1 s, 2 s, 4 s ... up to 30 s. */
export const retryDelayMs = (failures: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));

export function createSaver(dir: string, options: SaverOptions | number = {}) {
  const opts: SaverOptions = typeof options === 'number' ? { debounceMs: options } : options;
  const debounceMs = opts.debounceMs ?? 500;
  const write = opts.write ?? writeStateNow;
  const writeBak = opts.writeBak ?? ((d: string, s: AppState) => atomicWriteFileSync(join(d, FILE + '.bak'), serializeState(s)));
  const now = opts.now ?? Date.now;
  let pending: AppState | null = null;
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;
  let lastBak = now();
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, ms);
    timer.unref?.();
  };
  /** Writes the pending state now; true when nothing is left unsaved. Never throws: a failed save stays pending and is retried. */
  function flush(): boolean {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return true;
    const s = pending;
    pending = null;
    try {
      write(dir, s);
    } catch (error) {
      // A newer state saved meanwhile wins; otherwise this one is tried again.
      pending ??= s;
      failures++;
      if (failures === 1) opts.log?.(`state save failed, retrying: ${String((error as Error)?.message ?? error)}`);
      arm(retryDelayMs(failures));
      return false;
    }
    if (failures > 0) opts.log?.(`state saved again after ${failures} failed attempt(s)`);
    failures = 0;
    if (now() - lastBak >= BAK_REFRESH_MS) {
      lastBak = now();
      try { writeBak(dir, s); } catch { /* the next hour tries again */ }
    }
    return true;
  }
  return {
    save(state: AppState) {
      pending = state;
      // While a failed save waits for its retry, that timer stays (no tight loop of failing writes).
      if (!timer) arm(debounceMs);
    },
    flush,
    /** True while a state change is not on disk yet. */
    hasPending: () => pending !== null,
  };
}
