// state.json persistence: atomic writes, debounced saves, .bak fallback.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { defaultState, normalizeState } from '../shared/state';
import type { AppState } from '../shared/types';
import type { AppPlatform } from '../shared/platform';

const FILE = 'state.json';

function readState(path: string, platform: AppPlatform): AppState | null {
  try {
    return normalizeState(JSON.parse(readFileSync(path, 'utf8')), platform);
  } catch {
    return null;
  }
}

export function loadState(dir: string, platform: AppPlatform = 'win32'): AppState {
  mkdirSync(dir, { recursive: true });
  const main = join(dir, FILE);
  const bak = join(dir, FILE + '.bak');
  const state = existsSync(main) ? readState(main, platform) : null;
  if (state) {
    copyFileSync(main, bak);
    return state;
  }
  return (existsSync(bak) ? readState(bak, platform) : null) ?? defaultState(platform);
}

export function writeStateNow(dir: string, state: AppState): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, FILE);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  renameSync(tmp, target);
}

export function createSaver(dir: string, debounceMs = 500) {
  let pending: AppState | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const s = pending;
    pending = null;
    writeStateNow(dir, s);
  };
  return {
    save(state: AppState) {
      pending = state;
      if (!timer) timer = setTimeout(flush, debounceMs);
    },
    flush,
  };
}
