/**
 * At most one update window or prompt exists at any time: the startup prompt, the window opened from the status bar and
 * the hand-over to the detached installing window all take this lock first. Free of Electron imports.
 */
export type UpdateUiOwner = 'startup-gate' | 'install-window';

export interface UpdateUiGuard {
  /** True when `owner` now holds the lock; false when any owner (also the same one) already holds it. */
  acquire(owner: UpdateUiOwner): boolean;
  /** Releases the lock if `owner` holds it. */
  release(owner: UpdateUiOwner): void;
  owner(): UpdateUiOwner | undefined;
}

export function createUpdateUiGuard(): UpdateUiGuard {
  let held: UpdateUiOwner | undefined;
  return {
    acquire(owner) {
      if (held !== undefined) return false;
      held = owner;
      return true;
    },
    release(owner) { if (held === owner) held = undefined; },
    owner: () => held,
  };
}
