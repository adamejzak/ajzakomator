// Git marks of the Files tree: one status per project, read when the tree is shown, when the window gets the focus and after a git
// operation or a save. Nothing runs for a project that is not a trusted repository (the status runs the repository's filters).
import { useEffect } from 'react';
import { create } from 'zustand';
import { buildBadges, EMPTY_BADGES, type Badges } from '../../../shared/gitBadges';
import { getGitProbe, refreshGitProbe } from './gitProbe';

const useBadges = create<{ byProject: Record<string, Badges> }>(() => ({ byProject: {} }));
export const useProjectBadges = (projectId: string): Badges => useBadges((st) => st.byProject[projectId] ?? EMPTY_BADGES);

const timers = new Map<string, number>();
const sequence = new Map<string, number>();

async function load(projectId: string): Promise<void> {
  const mine = (sequence.get(projectId) ?? 0) + 1;
  sequence.set(projectId, mine);
  let next: Badges = EMPTY_BADGES;
  try {
    if (!getGitProbe(projectId)) await refreshGitProbe(projectId);
    if (getGitProbe(projectId) === 'repo') {
      const trust = await window.mc.git.trust(projectId, {});
      if (trust.ok && trust.data.state !== 'untrusted') {
        const status = await window.mc.git.status(projectId, {});
        if (status.ok) next = buildBadges(status.data.files, status.data.projectRelation, window.mc.platform === 'win32');
      }
    }
  } catch { /* no marks this time */ }
  if (sequence.get(projectId) === mine) useBadges.setState((st) => ({ byProject: { ...st.byProject, [projectId]: next } }));
}

/** Reads the marks again after `delay` ms (calls within the delay collapse into one). */
export function refreshGitBadges(projectId: string, delay = 300): void {
  window.clearTimeout(timers.get(projectId));
  timers.set(projectId, window.setTimeout(() => { timers.delete(projectId); void load(projectId); }, delay));
}

/** Keeps the marks of the project shown in the Files tree fresh while the tree is on screen. */
export function useGitBadgeSync(projectId: string, path: string): void {
  useEffect(() => {
    refreshGitBadges(projectId, 0);
    const onFocus = (): void => refreshGitBadges(projectId, 400);
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); window.clearTimeout(timers.get(projectId)); };
  }, [projectId, path]);
}
