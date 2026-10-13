import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { RefreshLimit, RefreshLimits } from './refresh';

/** An entry is forgotten this long after its window ended (its failure count only matters while the limiter is still engaged). */
const KEEP_AFTER_MS = 2 * 60 * 60_000;

/** In-memory limits, optionally mirrored to a small JSON file (fingerprints and times only, no tokens), so a restart keeps the window. */
export function createRefreshLimits(file: string | undefined, now: () => number = Date.now): RefreshLimits {
  const entries = new Map<string, RefreshLimit>();
  if (file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw)) {
          const entry = value as Partial<RefreshLimit> | null;
          if (/^[0-9a-f]{16}$/.test(key) && entry && Number.isFinite(entry.until) && Number.isInteger(entry.failures) && (entry.failures as number) > 0) {
            entries.set(key, { until: entry.until as number, failures: entry.failures as number });
          }
        }
      }
    } catch { /* no usable file yet */ }
  }
  const save = (): void => {
    if (!file) return;
    for (const [key, entry] of entries) if (entry.until + KEEP_AFTER_MS < now()) entries.delete(key);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* the in-memory copy still protects this run */ }
  };
  return {
    get: (key) => entries.get(key),
    set: (key, limit) => { entries.set(key, limit); save(); },
    delete: (key) => { if (entries.delete(key)) save(); },
  };
}
