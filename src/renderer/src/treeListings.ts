// Listings of the open folders of the project tree. Every folder that has to be shown is requested at once, in batches
// (one IPC call per batch instead of one per folder, and no waiting for the parent before the child is asked for).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectDirectory } from '../../shared/types';
import { shownFolders } from '../../shared/treeRows';
import { rememberKinds } from './explorer';

const BATCH = 250;
const FAILED: ProjectDirectory = { ok: false, error: 'Nie udało się wczytać folderu.' };

export interface TreeListings {
  /** The listing of a folder, undefined while its first load runs (a reload keeps the previous one). */
  get(path: string): ProjectDirectory | undefined;
  /** Changes whenever a listing arrived. */
  version: number;
  /** Folders whose listing is still being loaded (shown or not). */
  pending: number;
  retry(path: string): void;
}

export function useTreeListings(projectId: string, expanded: readonly string[] | undefined, refresh: number): TreeListings {
  const cache = useRef(new Map<string, ProjectDirectory>());
  /** Folders requested since the last refresh (a closed folder leaves the set and is reloaded when opened again). */
  const fresh = useRef(new Set<string>());
  /** The newest request of each folder: an older answer arriving later is dropped. */
  const tokens = useRef(new Map<string, number>());
  const seenRefresh = useRef(refresh);
  const alive = useRef(true);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(0);
  const counter = useRef(0);

  const load = useCallback((paths: string[]) => {
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH);
      const token = ++counter.current;
      for (const path of chunk) tokens.current.set(path, token);
      setPending((n) => n + chunk.length);
      const apply = (result: Record<string, ProjectDirectory> | null) => {
        if (!alive.current) return;
        for (const path of chunk) {
          if (tokens.current.get(path) !== token) continue;
          const listing = result?.[path] ?? FAILED;
          if (listing.ok) rememberKinds(projectId, listing.entries);
          cache.current.set(path, listing);
        }
        setPending((n) => n - chunk.length);
        setVersion((v) => v + 1);
      };
      window.mc.listProjectDirectoryBatch(projectId, chunk).then(apply, () => apply(null));
    }
  }, [projectId]);

  useEffect(() => {
    if (seenRefresh.current !== refresh) { seenRefresh.current = refresh; fresh.current.clear(); }
    const shown = shownFolders(expanded ?? []);
    const shownSet = new Set(shown);
    for (const path of fresh.current) if (!shownSet.has(path)) fresh.current.delete(path);
    const need = shown.filter((path) => !fresh.current.has(path));
    for (const path of need) fresh.current.add(path);
    if (need.length) load(need);
  }, [expanded, refresh, load]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const retry = useCallback((path: string) => {
    cache.current.delete(path);
    fresh.current.add(path);
    setVersion((v) => v + 1);
    load([path]);
  }, [load]);
  const get = useCallback((path: string) => cache.current.get(path), []);
  return { get, version, pending, retry };
}
