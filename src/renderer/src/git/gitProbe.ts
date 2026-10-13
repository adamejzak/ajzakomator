// What the rail knows about the active project: is it a git repository (and is git installed). Asked when the project changes and when
// the window gets the focus again (a `git init` or a clone outside the app shows up), never on a timer.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { GitProbe } from '../../../shared/git';

const useProbes = create<{ probes: Record<string, GitProbe> }>(() => ({ probes: {} }));

export const useGitProbe = (projectId: string | undefined): GitProbe | null => useProbes((st) => (projectId ? st.probes[projectId] ?? null : null));

/** The last probe of a project outside React (null: never asked). */
export const getGitProbe = (projectId: string | undefined): GitProbe | null => (projectId ? useProbes.getState().probes[projectId] ?? null : null);

export async function refreshGitProbe(projectId: string): Promise<void> {
  try {
    const probe = await window.mc.git.probe(projectId);
    if (useProbes.getState().probes[projectId] !== probe) useProbes.setState((st) => ({ probes: { ...st.probes, [projectId]: probe } }));
  } catch { /* the next focus asks again */ }
}

/** Keeps the probe of one project fresh while it is the active one. `path` changes when the project is relocated. */
export function useGitProbeSync(projectId: string | undefined, path: string | undefined): void {
  useEffect(() => {
    if (!projectId) return;
    void refreshGitProbe(projectId);
    let timer: number | undefined;
    const onFocus = (): void => { window.clearTimeout(timer); timer = window.setTimeout(() => void refreshGitProbe(projectId), 400); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [projectId, path]);
}
