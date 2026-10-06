import { describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/shared/env';
import { buildLaunchCommand, DEFAULT_PROFILES, psQuote } from '../src/shared/profiles';

const P = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.id, p]));

describe('buildLaunchCommand', () => {
  it('starts a new claude conversation with a fixed session id and our settings', () => {
    expect(buildLaunchCommand({ ...P.claude, args: '--model opus' }, { mode: 'new', sessionId: 'u1', claudeSettingsPath: 'C:\\a b\\x.json' }))
      .toBe("claude --session-id u1 --settings 'C:\\a b\\x.json' --model opus");
  });

  it('passes a startup prompt from a file in PowerShell and inline in cmd', () => {
    const initialPrompt = { file: 'C:/p/c1.txt', text: 'napraw "bug"\nteraz' };
    expect(buildLaunchCommand(P.codex, { mode: 'new', initialPrompt }))
      .toBe("codex -c tui.notifications=true (Get-Content -Raw -Encoding utf8 -LiteralPath 'C:/p/c1.txt')");
    expect(buildLaunchCommand(P.claude, { mode: 'new', initialPrompt, shell: 'cmd' })).toBe(`claude "napraw 'bug' teraz"`);
    expect(buildLaunchCommand(P.claude, { mode: 'resume', sessionId: 'x', initialPrompt })).toBe('claude --resume x');
  });

  it('double-quotes the settings path for cmd', () => {
    expect(buildLaunchCommand(P.claude, { mode: 'new', sessionId: 'u1', claudeSettingsPath: 'C:/a b/x.json', shell: 'cmd' }))
      .toBe('claude --session-id u1 --settings "C:/a b/x.json"');
  });

  it('resumes claude', () => {
    expect(buildLaunchCommand(P.claude, { mode: 'resume', sessionId: 'u1' })).toBe('claude --resume u1');
  });

  it('starts and resumes codex with terminal notifications', () => {
    expect(buildLaunchCommand(P.codex, { mode: 'new' })).toBe('codex -c tui.notifications=true');
    expect(buildLaunchCommand({ ...P.codex, args: '-c model_reasoning_effort=high' }, { mode: 'resume', sessionId: 's9' }))
      .toBe('codex resume s9 -c tui.notifications=true -c model_reasoning_effort=high');
  });

  it('returns null for shell profiles', () => {
    expect(buildLaunchCommand(P.shell, { mode: 'new' })).toBeNull();
  });

  it('psQuote escapes single quotes and keeps Polish characters', () => {
    expect(psQuote("D:\\Moje Projekty\\źródło's")).toBe("'D:\\Moje Projekty\\źródło''s'");
  });
});

describe('cleanEnv', () => {
  it('drops parent session vars but keeps user config', () => {
    const env = cleanEnv({
      PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'a',
      CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_ENABLE_TELEMETRY: '1', ELECTRON_RUN_AS_NODE: '1', U: undefined,
    });
    expect(env).toEqual({ PATH: 'x', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
  });
});
