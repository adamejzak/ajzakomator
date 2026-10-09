import { describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/shared/env';
import { buildLaunchCommand, DEFAULT_PROFILES, posixQuote, psQuote } from '../src/shared/profiles';

const P = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.id, p]));

describe('buildLaunchCommand', () => {
  it('quotes macOS settings and prompts safely for bash and zsh', () => {
    const path = "/Users/ala/Project's files/prompt.txt";
    const initialPrompt = { file: path, text: 'Napraw "błąd"\n$HOME; `whoami`' };
    for (const shell of ['zsh', 'bash'] as const) {
      const command = buildLaunchCommand(P.claude, { mode: 'new', shell, claudeSettingsPath: path, initialPrompt })!;
      expect(command).toContain("--settings '/Users/ala/Project'\"'\"'s files/prompt.txt'");
      expect(command).toContain('"$(cat ' + posixQuote(path) + ')"');
      expect(command).not.toContain('Get-Content');
      expect(command).not.toContain(initialPrompt.text);
    }
  });
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
  it('adds app-owned MCP settings without removing user CLI arguments', () => {
    const mcp = { url: 'http://127.0.0.1:12345/mcp', tokenEnv: 'AJZ_MCP_TOKEN', claudeConfigPath: "C:/User's files/mcp.json" };
    const claude = buildLaunchCommand({ ...P.claude, args: '--model opus' }, { mode: 'new', mcp })!;
    expect(claude).toContain("--mcp-config 'C:/User''s files/mcp.json'");
    expect(claude).toContain('--model opus');
    const codex = buildLaunchCommand(P.codex, { mode: 'resume', sessionId: 'known', mcp })!;
    expect(codex).toContain('codex resume known');
    expect(codex).toContain("'mcp_servers.ajzakomator.url=\"http://127.0.0.1:12345/mcp\"'");
    expect(codex).toContain("'mcp_servers.ajzakomator.bearer_token_env_var=\"AJZ_MCP_TOKEN\"'");
    expect(buildLaunchCommand(P.codex, { mode: 'new', shell: 'cmd', mcp })).toContain("mcp_servers.ajzakomator.url='http://127.0.0.1:12345/mcp'");
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'bash', mcp })).toContain("'C:/User'\"'\"'s files/mcp.json'");
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
      AJZ_MCP_TOKEN: 'parent-token', MC_CELL_ID: 'parent-cell',
    });
    expect(env).toEqual({ PATH: 'x', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
  });
});

describe('per-cell model overrides', () => {
  it('replaces a profile model while retaining unrelated CLI flags', () => {
    const command = buildLaunchCommand({ ...P.codex, args: '--model old-model --no-alt-screen' }, { mode: 'new', model: 'new-model' })!;
    expect(command).not.toContain('old-model');
    expect(command.match(/--model/g)).toHaveLength(1);
    expect(command).toContain('--no-alt-screen');
  });
  it('passes a quoted model to both agents for every supported shell', () => {
    for (const shell of ['pwsh', 'powershell', 'cmd', 'zsh', 'bash'] as const) {
      for (const profile of [P.claude, P.codex]) {
        const command = buildLaunchCommand(profile, { mode: 'new', model: 'provider/model-v2', shell })!;
        expect(command).toContain('--model');
        expect(command).toContain(shell === 'cmd' ? '"provider/model-v2"' : "'provider/model-v2'");
      }
    }
  });
  it('rejects model strings that could execute shell syntax', () => {
    for (const model of ['a;whoami', '%PATH%', 'a`id`', '$(id)', 'a"b', '-bad', 'a b']) {
      expect(() => buildLaunchCommand(P.codex, { mode: 'new', model })).toThrow('Invalid model');
    }
  });
});
