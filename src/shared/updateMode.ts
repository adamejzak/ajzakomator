/**
 * How updates are handled at app start. An update is never installed without an explicit click:
 * - manual: no startup window; the background check shows a status bar button the user clicks to install
 * - ask: the startup check asks "Install now / Later" when an update exists (shown as "Automatic" in the settings)
 */
export type UpdateMode = 'manual' | 'ask';

export const UPDATE_MODES: readonly UpdateMode[] = ['manual', 'ask'];
export const DEFAULT_UPDATE_MODE: UpdateMode = 'manual';

/**
 * Reads the saved mode. The retired 'auto' value and the retired boolean `autoInstallUpdates: true` both wanted
 * automatic updates, which now means 'ask'; false or nothing saved means 'manual'.
 */
export function normalizeUpdateMode(value: unknown, legacyAutoInstall?: unknown): UpdateMode {
  if (UPDATE_MODES.includes(value as UpdateMode)) return value as UpdateMode;
  if (value === 'auto') return 'ask';
  if (typeof legacyAutoInstall === 'boolean') return legacyAutoInstall ? 'ask' : 'manual';
  return DEFAULT_UPDATE_MODE;
}
