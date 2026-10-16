// Environment for scripts that launch the built app: never the real login folders or tokens of the person running the check.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const LOGIN_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CODEX_HOME'];

/** Deletes (in place) the login-related variables and the Electron dev variables; returns the same object. */
export function scrubAppEnv(env) {
  for (const key of LOGIN_ENV_KEYS) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  return env;
}

/**
 * A scratch home in `<root>/home` (with AppData\Roaming and AppData\Local: Electron needs both) and the variables that point
 * the app at it, so a launched app never reaches the real ~/.claude, ~/.codex or appData.
 */
export function scratchHome(root) {
  const home = join(root, 'home');
  const roaming = join(home, 'AppData', 'Roaming');
  const local = join(home, 'AppData', 'Local');
  for (const dir of [roaming, local]) mkdirSync(dir, { recursive: true });
  return { home, env: { USERPROFILE: home, HOME: home, APPDATA: roaming, LOCALAPPDATA: local } };
}

/** Removes a scratch home after the app has exited (retries while Windows still holds its files). */
export function removeScratchHome(home) {
  try { rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (error) { console.error(`scratch home not removed: ${home}: ${error.message}`); }
}
