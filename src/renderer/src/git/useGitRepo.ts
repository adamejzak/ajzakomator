// State of one repository for the Git panel: the status, refreshed when the window gets the focus (debounced) and after operations.
// The hook lives as long as the panel is on screen, so a hidden panel runs nothing: no listener, no timer.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitErrorCode, GitStatus } from '../../../shared/git';

export interface RepoError { code: GitErrorCode; message: string }

export interface GitRepoState {
  status: GitStatus | null;
  error: RepoError | null;
  loading: boolean;
  /** Reads the status after `delay` ms (calls within the delay collapse into one). */
  refresh(delay?: number): void;
  /** Reads the status now and resolves when it is in (for a visible "refreshing" state). */
  reload(): Promise<void>;
}

/**
 * `enabled` is false while the repository is not trusted: the status runs the repository's filters, so it is not asked for at all
 * (neither on opening the panel nor when the window gets the focus).
 */
export function useGitRepo(projectId: string, worktree: string | undefined, enabled = true): GitRepoState {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<RepoError | null>(null);
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    if (!enabled) return;
    const mine = ++sequence.current;
    try {
      const result = await window.mc.git.status(projectId, worktree ? { worktree } : {});
      if (mine !== sequence.current) return; // a newer read is on its way
      if (result.ok) { setStatus(result.data); setError(null); }
      else setError({ code: result.code, message: result.error });
    } catch (e) {
      if (mine === sequence.current) setError({ code: 'failed', message: String(e) });
    } finally {
      if (mine === sequence.current) setLoading(false);
    }
  }, [projectId, worktree, enabled]);

  const refresh = useCallback((delay = 250) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), delay);
  }, [load]);

  useEffect(() => {
    setStatus(null);
    setLoading(enabled);
    void load();
    const onFocus = (): void => refresh(400);
    window.addEventListener('focus', onFocus);
    return () => { window.clearTimeout(timer.current); sequence.current++; window.removeEventListener('focus', onFocus); };
  }, [load, refresh, enabled]);

  return { status, error, loading, refresh, reload: load };
}
