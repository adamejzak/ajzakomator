import { describe, expect, it } from 'vitest';
import {
  AgentInference, commandFromScreenLine, commandLineAgent, keySequence, parsePrompt, PROMPT_STABLE_MS, type ScreenLine, type ScreenState,
} from '../src/shared/agentInfer';
import { agentModeMessages } from '../src/shared/agentModeMessages';
import { buildPathText, normalizePathMode, resolveDropTarget } from '../src/shared/pathDrop';
import { addProject, addTab, defaultState, findCell, normalizeState, updateCell } from '../src/shared/state';
import { translate, type MessageKey } from '../src/shared/i18n';
import { LANGUAGES } from '../src/shared/languages';

describe('which command line starts an agent', () => {
  it('recognises the plain commands, with and without an extension or a path', () => {
    for (const line of ['claude', 'codex', 'claude --resume', 'codex "fix the build"', 'claude.cmd', 'claude.exe', 'codex.cmd', 'codex.exe', '  claude  ', 'claude.ps1']) {
      expect(commandLineAgent(line), line).toBe(line.includes('codex') ? 'codex' : 'claude');
    }
    expect(commandLineAgent('C:\\Users\\me\\.local\\bin\\claude.exe --model opus')).toBe('claude');
    expect(commandLineAgent('~/.local/bin/claude')).toBe('claude');
    expect(commandLineAgent('/usr/local/bin/codex resume')).toBe('codex');
    expect(commandLineAgent('"C:\\Program Files\\Claude\\claude.exe"')).toBe('claude');
    expect(commandLineAgent("'/opt/my tools/codex'")).toBe('codex');
    expect(commandLineAgent('& "C:\\tools\\codex.exe"')).toBe('codex');
  });

  it('never matches look-alikes', () => {
    for (const line of ['claudex', 'claude-code-helper', 'codex-cli', 'myclaude', 'claude_code', 'echo claude', 'cat claude.md', 'git commit -m claude', 'claudes', 'xcodex', '', '   ', 'C:\\x\\claudex.exe', './claude-helper']) {
      expect(commandLineAgent(line), line).toBeNull();
    }
  });

  it('matches the upper case name where the shell does (Windows) and not elsewhere', () => {
    expect(commandLineAgent('Claude')).toBe('claude');
    expect(commandLineAgent('CODEX.EXE')).toBe('codex');
    expect(commandLineAgent('Claude', false)).toBeNull();
    expect(commandLineAgent('claude', false)).toBe('claude');
  });

  it('looks through environment assignments, wrappers and chains', () => {
    expect(commandLineAgent('FOO=1 BAR="a b" claude')).toBe('claude');
    expect(commandLineAgent('env FOO=1 codex')).toBe('codex');
    expect(commandLineAgent('exec claude')).toBe('claude');
    expect(commandLineAgent('npx @anthropic-ai/claude-code')).toBe('claude');
    expect(commandLineAgent('npx -y @anthropic-ai/claude-code@latest --resume')).toBe('claude');
    expect(commandLineAgent('npx @openai/codex')).toBe('codex');
    expect(commandLineAgent('pnpm dlx @openai/codex@0.5.0')).toBe('codex');
    expect(commandLineAgent('bunx @anthropic-ai/claude-code')).toBe('claude');
    expect(commandLineAgent('npm exec -- @openai/codex')).toBe('codex');
    expect(commandLineAgent('cmd /c claude')).toBe('claude');
    expect(commandLineAgent('cmd.exe /k "codex --full-auto"')).toBe('codex');
    expect(commandLineAgent('cd app && claude')).toBe('claude');
    expect(commandLineAgent('$env:X = "1"; codex')).toBe('codex');
    expect(commandLineAgent('cd app; claude')).toBe('claude');
    expect(commandLineAgent('pnpm install')).toBeNull();
    expect(commandLineAgent('npx prettier .')).toBeNull();
    expect(commandLineAgent('npx claudex')).toBeNull();
    expect(commandLineAgent('cmd /c dir')).toBeNull();
    expect(commandLineAgent('claude && echo done')).toBeNull();
    expect(commandLineAgent('echo "a && claude"')).toBeNull();
  });

  it('ignores one-shot invocations that leave no TUI behind', () => {
    for (const line of ['claude --version', 'claude -v', 'claude --help', 'claude -p "hello"', 'claude --print x', 'claude mcp list', 'claude update', 'claude doctor', 'codex exec "x"', 'codex login', 'codex --version', 'codex mcp add x']) {
      expect(commandLineAgent(line), line).toBeNull();
    }
    expect(commandLineAgent('claude "explain mcp"')).toBe('claude');
    expect(commandLineAgent('codex resume')).toBe('codex');
  });

  it('judges a pasted block by its last line', () => {
    expect(commandLineAgent('cd app\nclaude')).toBe('claude');
    expect(commandLineAgent('claude\nls')).toBeNull();
    expect(commandLineAgent('claude\n\n')).toBe('claude');
  });
});

describe('prompts on the screen', () => {
  it('reads PowerShell, cmd and bash/zsh prompts with their folder and command', () => {
    expect(parsePrompt('PS D:\\Projekty\\app>')).toEqual({ command: '', cwd: 'D:\\Projekty\\app' });
    expect(parsePrompt('PS D:\\Projekty\\my app> claude --x')).toEqual({ command: 'claude --x', cwd: 'D:\\Projekty\\my app' });
    expect(parsePrompt('PS Microsoft.PowerShell.Core\\FileSystem::\\\\srv\\share> dir')).toEqual({ command: 'dir', cwd: null });
    expect(parsePrompt('D:\\Projekty\\app>codex')).toEqual({ command: 'codex', cwd: 'D:\\Projekty\\app' });
    expect(parsePrompt('me@box:~/app$ claude')).toEqual({ command: 'claude', cwd: null });
    expect(parsePrompt('me@box ~ %')).toEqual({ command: '', cwd: null });
    expect(parsePrompt('> claude')).toBeNull();
    expect(parsePrompt('│ > codex                      │')).toBeNull();
    expect(parsePrompt('Claude Code v2')).toBeNull();
  });

  it('takes the command from a generic prompt only outside TUI boxes', () => {
    expect(commandFromScreenLine('~/app main ❯ claude')).toBe('claude');
    expect(commandFromScreenLine('│ > codex │')).toBeNull();
    expect(commandFromScreenLine('> codex')).toBeNull();
    expect(commandFromScreenLine('PS C:\\x> codex')).toBe('codex');
  });
});

describe('key sequences', () => {
  it('encodes the keys the app sends itself', () => {
    expect(keySequence({ key: 'a' })).toBe('a');
    expect(keySequence({ key: 'Enter' })).toBe('\r');
    expect(keySequence({ key: 'c', ctrlKey: true })).toBe('\x03');
    expect(keySequence({ key: 'U', ctrlKey: true })).toBe('\x15');
    expect(keySequence({ key: 'Backspace' })).toBe('\x7f');
    expect(keySequence({ key: 'ArrowLeft' })).toBe('\x1b[D');
    expect(keySequence({ key: 'F5' })).toBe('');
    expect(keySequence({ key: 'Shift' })).toBe('');
    expect(keySequence({ key: 'v', metaKey: true })).toBe('');
    expect(keySequence({ key: 'b', altKey: true })).toBe('\x1bb');
  });
});

/** A shell cell: typed text goes in, the screen is whatever the test says it is. */
function shell(opts: { caseInsensitive?: boolean } = {}) {
  let now = 1000;
  let screen: ScreenLine | null = { text: 'PS D:\\app>', row: 5 };
  const infer = new AgentInference(opts.caseInsensitive ?? true);
  const api = {
    infer,
    get now() { return now; },
    advance: (ms: number) => { now += ms; },
    show: (text: string, row = 5) => { screen = { text, row }; },
    /** Types text; the screen line shows prompt + typed text, like a shell echoing it. */
    type: (data: string) => infer.input(data, now, () => screen),
    state: (over: Partial<ScreenState> = {}): ScreenState => ({ line: screen, alternate: false, mouse: false, ...over }),
    observe: (over: Partial<ScreenState> = {}) => infer.observe(now, api.state(over)),
    out: () => infer.output(now),
  };
  return api;
}

describe('line buffer and inference', () => {
  it('infers the agent when the typed command is submitted, not before', () => {
    const s = shell();
    s.type('claude');
    expect(s.infer.agent).toBeNull();
    s.type('\r');
    expect(s.infer.agent).toBe('claude');
  });

  it('infers from keys typed one at a time, and from Codex', () => {
    const s = shell();
    for (const ch of 'codex') s.type(ch);
    s.type('\r');
    expect(s.infer.agent).toBe('codex');
  });

  it('follows backspace and cursor edits', () => {
    const s = shell();
    s.type('claudx');
    s.type('\x7f');
    s.type('e\r');
    expect(s.infer.agent).toBe('claude');

    const t = shell();
    t.type('laude');
    t.type('\x1b[H'); // Home
    t.type('c\r');
    expect(t.infer.agent).toBe('claude');

    const u = shell();
    u.type('clade');
    u.type('\x1b[D\x1b[D'); // two to the left, between "cla" and "de"
    u.type('u\r');
    expect(u.infer.agent).toBe('claude');

    const v = shell();
    v.type('claudeX\x1b[D\x1b[3~\r'); // Delete removes the X after the cursor
    expect(v.infer.agent).toBe('claude');
  });

  it('forgets the line on Ctrl+C, Ctrl+U and Esc', () => {
    for (const reset of ['\x03', '\x15', '\x1b']) {
      const s = shell();
      s.type('claude');
      s.type(reset);
      s.type('\r');
      expect(s.infer.agent, JSON.stringify(reset)).toBeNull();
      s.type('ls\r');
      expect(s.infer.agent).toBeNull();
    }
    const s = shell();
    s.type('echo hi');
    s.type('\x15');
    s.type('codex\r');
    expect(s.infer.agent).toBe('codex');
  });

  it('handles Ctrl+A / Ctrl+E / Ctrl+K / Ctrl+W editing', () => {
    const s = shell();
    s.type('xx claude');
    s.type('\x01\x0b'); // start of line, kill to end
    s.type('codex\r');
    expect(s.infer.agent).toBe('codex');

    const t = shell();
    t.type('git status claude');
    t.type('\x17'); // delete word backwards
    t.type('\x17');
    t.type('\x17');
    t.type('claude\r');
    expect(t.infer.agent).toBe('claude');
  });

  it('ignores terminal replies, focus and mouse reports mixed into the input', () => {
    const s = shell();
    s.type('cla');
    s.type('\x1b[I');
    s.type('\x1b[<0;10;5M');
    s.type('\x1b[?1;2c');
    s.type('ude\r');
    expect(s.infer.agent).toBe('claude');
  });

  it('takes a bracketed paste literally, its newlines included', () => {
    const s = shell();
    s.type('\x1b[200~cd app\nclaude\x1b[201~');
    expect(s.infer.agent).toBeNull(); // pasting is not submitting
    s.type('\r');
    expect(s.infer.agent).toBe('claude');

    const t = shell();
    t.type('\x1b[200~claude\nls\x1b[201~\r');
    expect(t.infer.agent).toBeNull();

    const u = shell();
    u.type('\x1b[200~claude --resume\x1b[201~');
    u.type('\r');
    expect(u.infer.agent).toBe('claude');
  });

  it('keeps a paste that arrives in pieces together', () => {
    const s = shell();
    s.type('\x1b[200~cla');
    s.type('ude');
    s.type('\x1b[201~\r');
    expect(s.infer.agent).toBe('claude');
  });

  it('treats a raw (not bracketed) multi-line paste as separate submitted lines', () => {
    const s = shell();
    s.type('cd app\rclaude\r');
    expect(s.infer.agent).toBe('claude');
  });

  it('does not trust the buffer after history or completion and reads the screen at Enter instead', () => {
    const s = shell();
    s.type('\x1b[A'); // Up: history recall
    s.show('PS D:\\app> claude --resume');
    s.type('\r');
    expect(s.infer.agent).toBe('claude');

    const t = shell();
    t.type('cl\t');
    t.show('PS D:\\app> codex');
    t.type('\r');
    expect(t.infer.agent).toBe('codex');

    const u = shell();
    u.type('\x1b[A');
    u.show('PS D:\\app> dir');
    u.type('\r');
    expect(u.infer.agent).toBeNull();

    const w = shell();
    w.type('\x1b[A');
    w.type('\r'); // screen unreadable
    expect(w.infer.agent).toBeNull();
  });

  it('keeps the buffer bounded', () => {
    const s = shell();
    s.type(`${'x'.repeat(10_000)}\r`);
    s.type('claude\r');
    expect(s.infer.agent).toBe('claude');
  });

  it('uses the folder of the prompt, else the folder the shell reported', () => {
    const s = shell();
    s.show('PS D:\\Projekty\\app\\sub> claude');
    s.type('claude\r');
    expect(s.infer.cwd).toBe('D:\\Projekty\\app\\sub');

    const t = shell();
    t.infer.reportCwd('"D:\\other"');
    t.show('custom> claude');
    t.type('claude\r');
    expect(t.infer.cwd).toBe('D:\\other');

    const u = shell();
    u.show('custom> claude');
    u.type('claude\r');
    expect(u.infer.cwd).toBeNull();
  });
});

describe('what happens to typed lines while an agent runs', () => {
  it('treats them as the agent\'s input: no re-inference inside a TUI', () => {
    const s = shell();
    s.type('claude\r');
    s.show('│ > codex                    │', 9);
    s.type('codex\r');
    expect(s.infer.agent).toBe('claude');
    s.show('> exit', 9);
    s.type('exit\r');
    expect(s.infer.agent).toBe('claude'); // `exit` went to the agent, not to the shell
  });

  it('accepts a command typed at a shell prompt that came back', () => {
    const s = shell();
    s.type('claude\r');
    s.show('PS D:\\app> codex', 12);
    s.type('codex\r');
    expect(s.infer.agent).toBe('codex');
    s.show('PS D:\\app> dir', 14);
    s.type('dir\r');
    expect(s.infer.agent).toBeNull();
  });
});

describe('clearing the guess', () => {
  it('clears when a shell prompt stays on a quiet screen for 1.5 s (a new line below the command)', () => {
    const s = shell();
    s.type('claude\r');
    s.advance(300);
    s.show('PS D:\\app>', 12);
    expect(s.observe()).toBe(false);
    s.advance(PROMPT_STABLE_MS - 1);
    expect(s.observe()).toBe(false);
    s.advance(1);
    expect(s.observe()).toBe(true);
    expect(s.infer.agent).toBeNull();
  });

  it('does not clear while the prompt is still the line the command was typed on', () => {
    const s = shell();
    s.type('claude\r'); // submitted on row 5
    s.advance(10_000);
    expect(s.observe()).toBe(false);
    expect(s.infer.agent).toBe('claude');
  });

  it('does not clear on a prompt shown inside the TUI (full screen, mouse tracking), or text that merely looks like one', () => {
    const s = shell();
    s.type('codex\r');
    s.show('PS D:\\app>', 12);
    s.advance(5000);
    expect(s.observe({ alternate: true })).toBe(false);
    s.advance(5000);
    expect(s.observe({ mouse: true })).toBe(false);
    s.show('  PS D:\\app> (an example in the answer)', 14);
    s.advance(5000);
    expect(s.observe()).toBe(false);
    expect(s.infer.agent).toBe('codex');
  });

  it('accepts a prompt on the same row once the full-screen program has been seen leaving', () => {
    const s = shell();
    s.type('codex\r');
    s.advance(500);
    expect(s.observe({ alternate: true, line: null })).toBe(false);
    s.advance(500);
    s.show('PS D:\\app>', 5);
    expect(s.observe()).toBe(false);
    s.advance(PROMPT_STABLE_MS);
    expect(s.observe()).toBe(true);
  });

  it('waits for the output to stop and for the prompt to stay put', () => {
    const s = shell();
    s.type('claude\r');
    s.show('PS D:\\app>', 12);
    expect(s.observe()).toBe(false);
    s.advance(1000);
    s.out();
    s.advance(1000);
    expect(s.observe()).toBe(false); // output 1 s ago
    s.advance(600);
    expect(s.observe()).toBe(true);

    const t = shell();
    t.type('claude\r');
    t.show('PS D:\\app>', 12);
    t.observe();
    t.advance(1000);
    t.show('PS D:\\app>', 13); // the prompt moved: a different prompt, the timer starts again
    expect(t.observe()).toBe(false);
    t.advance(1000);
    expect(t.observe()).toBe(false);
    t.advance(600);
    expect(t.observe()).toBe(true);
  });

  it('clears on a shell title that arrives after the agent started and stays 1.5 s', () => {
    const s = shell();
    s.type('claude\r');
    s.advance(100);
    s.infer.title('Windows PowerShell', s.now); // too soon after the command: the shell's own title
    s.advance(PROMPT_STABLE_MS);
    expect(s.observe()).toBe(false);
    s.advance(400);
    s.infer.title('C:\\WINDOWS\\system32\\cmd.exe', s.now);
    expect(s.observe()).toBe(false);
    s.advance(PROMPT_STABLE_MS);
    expect(s.observe()).toBe(true);
  });

  it('ignores agent titles and forgets a shell title that the agent replaced', () => {
    const s = shell();
    s.type('codex\r');
    s.advance(1000);
    s.infer.title('Windows PowerShell', s.now);
    s.advance(200);
    s.infer.title('✳ Claude Code', s.now);
    s.advance(5000);
    expect(s.observe()).toBe(false);
    expect(s.infer.agent).toBe('codex');
  });

  it('clears when the pty exits or respawns, and forgets typed text', () => {
    const s = shell();
    s.type('claude\r');
    s.type('half a line');
    s.infer.exited();
    expect(s.infer.agent).toBeNull();
    s.type('\r');
    expect(s.infer.agent).toBeNull();
    s.type('x\r');
    expect(s.infer.agent).toBeNull();
  });

  it('does nothing without an agent', () => {
    const s = shell();
    expect(s.observe()).toBe(false);
    s.infer.title('Windows PowerShell', s.now);
    expect(s.observe()).toBe(false);
  });

  it('a different command at the prompt replaces or clears the guess', () => {
    const s = shell();
    s.type('claude\r');
    s.show('PS D:\\app> codex', 12);
    s.type('codex\r');
    expect(s.infer.agent).toBe('codex');
    expect(s.infer.cwd).toBe('D:\\app');
  });
});

describe('path format of a drop', () => {
  const win = { cwd: 'D:\\Projekty\\app', platform: 'win32' as const, shell: 'pwsh' as const };
  const file = [{ kind: 'file' as const, abs: 'D:\\Projekty\\app\\src\\a b.ts' }];

  it('real agent cells keep their agent format whatever else is set', () => {
    expect(resolveDropTarget('claude', 'shell', 'codex')).toBe('claude');
    expect(resolveDropTarget('codex', undefined, null)).toBe('codex');
    expect(resolveDropTarget('claude', 'codex', null)).toBe('claude');
  });

  it('shell cells follow the override, else the inferred agent, else the shell format', () => {
    expect(resolveDropTarget('shell', undefined, null)).toBe('shell');
    expect(resolveDropTarget('shell', undefined, 'claude')).toBe('claude');
    expect(resolveDropTarget('shell', undefined, 'codex')).toBe('codex');
    expect(resolveDropTarget('shell', 'shell', 'claude')).toBe('shell');
    expect(resolveDropTarget('shell', 'codex', 'claude')).toBe('codex');
    expect(resolveDropTarget('shell', 'claude', null)).toBe('claude');
    expect(resolveDropTarget('shell', 'bogus', 'codex')).toBe('codex');
  });

  it('produces the three formats', () => {
    expect(buildPathText(resolveDropTarget('shell', undefined, 'claude'), file, win).text).toBe('@"src/a b.ts" ');
    expect(buildPathText(resolveDropTarget('shell', undefined, 'codex'), file, win).text).toBe('"src/a b.ts" ');
    expect(buildPathText(resolveDropTarget('shell', undefined, null), file, win).text).toBe("'D:\\Projekty\\app\\src\\a b.ts' ");
  });

  it('keeps hostile names safe in every format', () => {
    const hostile = [{ kind: 'file' as const, abs: 'D:\\Projekty\\app\\a\u001b[201~b' }, { kind: 'file' as const, abs: 'D:\\Projekty\\app\\x\ny' }, { kind: 'file' as const, abs: 'D:\\Projekty\\app\\ok.txt' }];
    for (const agent of ['claude', 'codex', null] as const) {
      const result = buildPathText(resolveDropTarget('shell', undefined, agent), hostile, win);
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(result.text)).toBe(false);
      expect(result.skipped).toBe(2);
      expect(result.text).toContain('ok.txt');
    }
  });
});

describe('the per-cell path format setting', () => {
  it('accepts only the known values', () => {
    expect(normalizePathMode('claude')).toBe('claude');
    expect(normalizePathMode('codex')).toBe('codex');
    expect(normalizePathMode('shell')).toBe('shell');
    for (const bad of ['auto', 'Claude', '', null, undefined, 3, {}, ['claude']]) expect(normalizePathMode(bad), String(bad)).toBeUndefined();
  });

  it('is stored on the cell, can be removed, and survives a save and load', () => {
    let s = addProject(defaultState(), { name: 'p', path: 'D:\\p' });
    s = addTab(s, s.projects[0].id, { layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] } as never, cells: [{ profileId: 'shell' }] });
    const id = s.projects[0].tabs[0].cells[0].id;
    expect(findCell(s, id)!.cell.pathMode).toBeUndefined();
    s = updateCell(s, id, { pathMode: 'codex' });
    const reloaded = normalizeState(JSON.parse(JSON.stringify(s)))!;
    expect(findCell(reloaded, id)!.cell.pathMode).toBe('codex');
    s = updateCell(s, id, { pathMode: undefined });
    expect('pathMode' in findCell(s, id)!.cell).toBe(false);
    expect('pathMode' in findCell(normalizeState(JSON.parse(JSON.stringify(s)))!, id)!.cell).toBe(false);
  });

  it('drops an unknown value from a saved file, in open and archived tabs', () => {
    let s = addProject(defaultState(), { name: 'p', path: 'D:\\p' });
    s = addTab(s, s.projects[0].id, { layout: { cols: 1, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }] } as never, cells: [{ profileId: 'shell' }] });
    const raw = JSON.parse(JSON.stringify(s));
    const cell = raw.projects[0].tabs[0].cells[0];
    cell.pathMode = 'powershell';
    raw.projects[0].archive = [{ ...raw.projects[0].tabs[0], id: 'old', closedAt: 1, cells: [{ ...cell, id: 'c2', pathMode: 'claude' }, { ...cell, id: 'c3', pathMode: 7 }] }];
    const loaded = normalizeState(raw)!;
    expect('pathMode' in loaded.projects[0].tabs[0].cells[0]).toBe(false);
    expect(loaded.projects[0].archive[0].cells[0].pathMode).toBe('claude');
    expect('pathMode' in loaded.projects[0].archive[0].cells[1]).toBe(false);
  });
});

describe('texts', () => {
  it('has all six languages for the new messages', () => {
    for (const key of Object.keys(agentModeMessages) as MessageKey[]) {
      for (const { code } of LANGUAGES) expect(translate(code, key).trim().length, `${code}: ${key}`).toBeGreaterThan(0);
      expect(translate('en', key)).not.toBe(key);
    }
    expect(/\u2014/.test(JSON.stringify(agentModeMessages))).toBe(false);
  });
});
