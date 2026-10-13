import { describe, expect, it } from 'vitest';
import { cleanEnv } from '../src/shared/env';
import { buildCliCommand, buildLaunchCommand, DEFAULT_PROFILES, posixQuote, psQuote } from '../src/shared/profiles';
import { INPUT_MODES_OFF } from '../src/shared/termReset';

const P = Object.fromEntries(DEFAULT_PROFILES.map((p) => [p.id, p]));

describe('buildCliCommand', () => {
  it('quotes macOS settings and prompts safely for bash and zsh', () => {
    const path = "/Users/ala/Project's files/prompt.txt";
    const initialPrompt = { file: path, text: 'Napraw "błąd"\n$HOME; `whoami`' };
    for (const shell of ['zsh', 'bash'] as const) {
      const command = buildCliCommand(P.claude, { mode: 'new', shell, claudeSettingsPath: path, initialPrompt })!;
      expect(command).toContain("--settings '/Users/ala/Project'\"'\"'s files/prompt.txt'");
      expect(command).toContain('"$(cat ' + posixQuote(path) + ')"');
      expect(command).not.toContain('Get-Content');
      expect(command).not.toContain(initialPrompt.text);
    }
  });
  it('starts a new claude conversation with a fixed session id and our settings', () => {
    expect(buildCliCommand({ ...P.claude, args: '--model opus' }, { mode: 'new', sessionId: 'u1', claudeSettingsPath: 'C:\\a b\\x.json' }))
      .toBe("claude --session-id u1 --settings 'C:\\a b\\x.json' --model opus");
  });

  it('passes a startup prompt from a file in PowerShell and inline in cmd', () => {
    const initialPrompt = { file: 'C:/p/c1.txt', text: 'napraw "bug"\nteraz' };
    expect(buildCliCommand(P.codex, { mode: 'new', initialPrompt }))
      .toBe("codex -c tui.notifications=true (Get-Content -Raw -Encoding utf8 -LiteralPath 'C:/p/c1.txt')");
    expect(buildCliCommand(P.claude, { mode: 'new', initialPrompt, shell: 'cmd' })).toBe(`claude "napraw 'bug' teraz"`);
    expect(buildCliCommand(P.claude, { mode: 'resume', sessionId: 'x', initialPrompt })).toBe('claude --resume x');
  });

  it('double-quotes the settings path for cmd', () => {
    expect(buildCliCommand(P.claude, { mode: 'new', sessionId: 'u1', claudeSettingsPath: 'C:/a b/x.json', shell: 'cmd' }))
      .toBe('claude --session-id u1 --settings "C:/a b/x.json"');
  });

  it('resumes claude', () => {
    expect(buildCliCommand(P.claude, { mode: 'resume', sessionId: 'u1' })).toBe('claude --resume u1');
  });

  it('starts and resumes codex with terminal notifications', () => {
    expect(buildCliCommand(P.codex, { mode: 'new' })).toBe('codex -c tui.notifications=true');
    expect(buildCliCommand({ ...P.codex, args: '-c model_reasoning_effort=high' }, { mode: 'resume', sessionId: 's9' }))
      .toBe('codex resume s9 -c tui.notifications=true -c model_reasoning_effort=high');
  });

  it('returns null for shell profiles', () => {
    expect(buildCliCommand(P.shell, { mode: 'new' })).toBeNull();
  });
  it('adds app-owned MCP settings without removing user CLI arguments', () => {
    const mcp = { url: 'http://127.0.0.1:12345/mcp', tokenEnv: 'AJZ_MCP_TOKEN', claudeConfigPath: "C:/User's files/mcp.json" };
    const claude = buildCliCommand({ ...P.claude, args: '--model opus' }, { mode: 'new', mcp })!;
    expect(claude).toContain("--mcp-config 'C:/User''s files/mcp.json'");
    expect(claude).toContain('--model opus');
    const codex = buildCliCommand(P.codex, { mode: 'resume', sessionId: 'known', mcp })!;
    expect(codex).toContain('codex resume known');
    expect(codex).toContain("'mcp_servers.ajzakomator.url=\"http://127.0.0.1:12345/mcp\"'");
    expect(codex).toContain("'mcp_servers.ajzakomator.bearer_token_env_var=\"AJZ_MCP_TOKEN\"'");
    expect(buildCliCommand(P.codex, { mode: 'new', shell: 'cmd', mcp })).toContain("mcp_servers.ajzakomator.url='http://127.0.0.1:12345/mcp'");
    expect(buildCliCommand(P.claude, { mode: 'new', shell: 'bash', mcp })).toContain("'C:/User'\"'\"'s files/mcp.json'");
  });

  it('psQuote escapes single quotes and keeps Polish characters', () => {
    expect(psQuote("D:\\Moje Projekty\\źródło's")).toBe("'D:\\Moje Projekty\\źródło''s'");
  });
});

describe('buildLaunchCommand (typed line with the terminal reset tail)', () => {
  it('keeps the exact CLI command first and appends the reset per shell', () => {
    for (const shell of ['pwsh', 'powershell', 'cmd', 'zsh', 'bash'] as const) {
      for (const profile of [P.claude, P.codex]) {
        const opts = { mode: 'resume' as const, sessionId: 's1', shell, claudeSettingsPath: 'C:/a b/x.json' };
        const cli = buildCliCommand(profile, opts)!;
        const line = buildLaunchCommand(profile, opts)!;
        expect(line.startsWith(cli)).toBe(true);
        expect(line.slice(cli.length)).toContain('1000;1002;1003;1005;1006;1015;1004;2004l');
        expect(line).not.toMatch(/[\r\n]/);
      }
    }
  });
  it('runs the reset after the CLI also when it fails, with the separator of the shell', () => {
    expect(buildLaunchCommand(P.claude, { mode: 'new' })).toMatch(/^claude; \[Console\]::Write\(/);
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'powershell' })).toMatch(/^claude; \[Console\]::Write\(/);
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'cmd' })).toMatch(/^claude & powershell -NoProfile -NonInteractive -Command "\[Console\]::Write\(.*\)" 2>nul$/);
    for (const shell of ['zsh', 'bash'] as const) expect(buildLaunchCommand(P.codex, { mode: 'new', shell })).toMatch(/^codex -c tui\.notifications=true; printf '\\033\[\?1000;/);
  });
  it('writes the escape character through the shell, never typed into the line', () => {
    for (const shell of ['pwsh', 'cmd', 'zsh'] as const) expect(buildLaunchCommand(P.claude, { mode: 'new', shell })).not.toContain('\x1b');
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'cmd' })).toContain("[char]27+'[?");
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'bash' })).toContain('\\033[?');
  });
  it('leaves the initial prompt and its quoting alone', () => {
    const initialPrompt = { file: 'C:/p/c1.txt', text: 'napraw "bug"' };
    expect(buildLaunchCommand(P.claude, { mode: 'new', initialPrompt })!).toContain("claude (Get-Content -Raw -Encoding utf8 -LiteralPath 'C:/p/c1.txt'); ");
    expect(buildLaunchCommand(P.claude, { mode: 'new', shell: 'cmd', initialPrompt })!.startsWith(`claude "napraw 'bug'" & `)).toBe(true);
  });
  it('never clears win32-input-mode, which ConPTY owns', () => {
    expect(INPUT_MODES_OFF).not.toContain('9001');
    expect(buildLaunchCommand(P.claude, { mode: 'new' })).not.toContain('9001');
  });
  it('adds nothing for plain shell profiles', () => {
    expect(buildLaunchCommand(P.shell, { mode: 'new', shell: 'cmd' })).toBeNull();
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
    const command = buildCliCommand({ ...P.codex, args: '--model old-model --no-alt-screen' }, { mode: 'new', model: 'new-model' })!;
    expect(command).not.toContain('old-model');
    expect(command.match(/--model/g)).toHaveLength(1);
    expect(command).toContain('--no-alt-screen');
  });
  it('passes a quoted model to both agents for every supported shell', () => {
    for (const shell of ['pwsh', 'powershell', 'cmd', 'zsh', 'bash'] as const) {
      for (const profile of [P.claude, P.codex]) {
        const command = buildCliCommand(profile, { mode: 'new', model: 'provider/model-v2', shell })!;
        expect(command).toContain('--model');
        expect(command).toContain(shell === 'cmd' ? '"provider/model-v2"' : "'provider/model-v2'");
      }
    }
  });
  it('rejects model strings that could execute shell syntax', () => {
    for (const model of ['a;whoami', '%PATH%', 'a`id`', '$(id)', 'a"b', '-bad', 'a b']) {
      expect(() => buildCliCommand(P.codex, { mode: 'new', model })).toThrow('Invalid model');
    }
  });
});
