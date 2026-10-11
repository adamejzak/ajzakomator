/**
 * How updates are handled at app start:
 * - manual: no startup window; the background check shows a status bar button the user clicks to install
 * - ask: the startup check asks "Install now / Later" when an update exists
 * - auto: the startup check downloads and installs without asking; a downloaded update also installs on close
 */
export type UpdateMode = 'manual' | 'ask' | 'auto';

export const UPDATE_MODES: readonly UpdateMode[] = ['manual', 'ask', 'auto'];
export const DEFAULT_UPDATE_MODE: UpdateMode = 'manual';

/** Reads the saved mode; the retired boolean `autoInstallUpdates` maps true -> auto, false -> manual. */
export function normalizeUpdateMode(value: unknown, legacyAutoInstall?: unknown): UpdateMode {
  if (UPDATE_MODES.includes(value as UpdateMode)) return value as UpdateMode;
  if (typeof legacyAutoInstall === 'boolean') return legacyAutoInstall ? 'auto' : 'manual';
  return DEFAULT_UPDATE_MODE;
}
