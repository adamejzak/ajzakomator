// Environment for scripts that launch the built app: never the real login folders or tokens of the person running the check.
export const LOGIN_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CODEX_HOME'];

/** Deletes (in place) the login-related variables and the Electron dev variables; returns the same object. */
export function scrubAppEnv(env) {
  for (const key of LOGIN_ENV_KEYS) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  return env;
}
