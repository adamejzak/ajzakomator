import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { LOGIN_ENV_KEYS, scrubAppEnv } from '../scripts/app-env.mjs';

describe('scrubAppEnv', () => {
  it('drops the login folders and tokens and the Electron dev variables, keeps the rest', () => {
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: 'C:\real\.claude', CLAUDE_CODE_OAUTH_TOKEN: 'sk-real', ANTHROPIC_API_KEY: 'sk-ant', CODEX_HOME: 'C:\real\.codex',
      ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'http://localhost', PATH: 'x', MC_DATA_DIR: 'd',
    };
    const out = scrubAppEnv(env);
    expect(out).toBe(env);
    expect(env).toEqual({ PATH: 'x', MC_DATA_DIR: 'd' });
    expect(LOGIN_ENV_KEYS).toEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CODEX_HOME']);
  });
});
