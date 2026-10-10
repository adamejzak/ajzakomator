import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { parseReleases, type ChangelogEntry, type ChangelogResult } from '../shared/changelog';

export const RELEASES_API = 'https://api.github.com/repos/adamejzak/ajzakomator/releases?per_page=30';
const FRESH_MS = 10 * 60 * 1000;

export interface ChangelogOptions {
  fetchJson: (url: string) => Promise<unknown>;
  /** Where the last successful answer is kept for offline use. */
  cacheFile: string;
  now?: () => number;
}

/** Fetches release notes from GitHub, remembers them in memory and on disk, and falls back to the saved copy offline. */
export function createChangelog({ fetchJson, cacheFile, now = Date.now }: ChangelogOptions) {
  let memory: { entries: ChangelogEntry[]; at: number } | undefined;
  let pending: Promise<ChangelogResult> | undefined;

  const saved = async (): Promise<ChangelogEntry[]> => {
    if (memory) return memory.entries;
    try {
      const entries = parseReleases(JSON.parse(await readFile(cacheFile, 'utf8')));
      return entries;
    } catch { return []; }
  };

  const load = async (): Promise<ChangelogResult> => {
    try {
      const json = await fetchJson(RELEASES_API);
      const entries = parseReleases(json);
      memory = { entries, at: now() };
      await mkdir(dirname(cacheFile), { recursive: true }).then(() => writeFile(cacheFile, JSON.stringify(json))).catch(() => { /* cache is optional */ });
      return { entries, stale: false };
    } catch (error) {
      const entries = await saved();
      return { entries, stale: entries.length > 0, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    async get(force = false): Promise<ChangelogResult> {
      if (!force && memory && now() - memory.at < FRESH_MS) return { entries: memory.entries, stale: false };
      pending ??= load().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
