// Variables describing the session that launched us (e.g. a parent Claude Code). Leaking them makes
// child `claude` instances think they are sub-sessions (no transcript saving, wrong messaging socket).
const SESSION_ENV =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT|CLAUDE_CODE_(CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_.*|SESSION_.*)|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL)$/i;

export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SESSION_ENV.test(k)) out[k] = v;
  return out;
}
