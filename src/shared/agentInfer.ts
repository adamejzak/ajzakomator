// Guessing which agent runs inside a plain shell cell. The user types `claude` or `codex` into a PowerShell / cmd / bash
// cell by hand, so the cell's profile says "shell" while an agent TUI owns the terminal. Dropped paths should then use the
// agent's format, so the app follows what the user submits (a line buffer fed by the input path) and later what the screen
// shows (a shell prompt is back). Everything here is a heuristic with an injected clock and no DOM: wrong guesses must be
// rare, and the per-cell override (Cell.pathMode) always fixes one.

export type InferredAgent = 'claude' | 'codex';

/** A shell prompt that stays on a quiet screen this long means the agent is gone. */
export const PROMPT_STABLE_MS = 1500;
const MAX_LINE = 4096;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// ── the submitted command line ───────────────────────────────────────────────

/** Splits at `&`, `|`, `;` and newlines outside quotes (so `cd x && claude` yields the command that ends up running). */
function splitSegments(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') {
      segments.push(current);
      current = '';
    } else current += ch;
  }
  segments.push(current);
  return segments;
}

/** Whitespace-separated words with their quotes removed. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

const baseName = (token: string, ci: boolean): string => {
  const base = token.split(/[\\/]/).pop() ?? '';
  return ci ? base.toLowerCase() : base;
};

/** `claude`, `claude.exe`, `C:\x\claude.cmd`, `~/.local/bin/claude`; never `claudex` or `claude-code-helper`. */
function executableAgent(token: string, ci: boolean): InferredAgent | null {
  const match = /^(claude|codex)(?:\.(?:cmd|exe|ps1|bat))?$/.exec(baseName(token, ci));
  return match ? (match[1] as InferredAgent) : null;
}

function packageAgent(token: string, ci: boolean): InferredAgent | null {
  const bare = token.replace(/^(@?[^@]+)@.*$/, '$1');
  if (/^@anthropic-ai\/claude-code$/i.test(bare)) return 'claude';
  if (/^@openai\/codex$/i.test(bare)) return 'codex';
  return executableAgent(bare, ci);
}

/** Runs and exits (version, help, print mode, account and config subcommands): no TUI stays on the screen. */
function oneShot(agent: InferredAgent, args: string[]): boolean {
  if (args.some((arg) => ['--version', '-v', '-V', '--help', '-h'].includes(arg))) return true;
  if (agent === 'claude' && args.some((arg) => arg === '-p' || arg === '--print')) return true;
  const first = args[0];
  if (!first || first.startsWith('-')) return false;
  const subcommands = agent === 'claude'
    ? ['mcp', 'config', 'update', 'upgrade', 'doctor', 'install', 'migrate-installer', 'setup-token', 'plugin', 'plugins', 'api-key']
    : ['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'completion', 'apply', 'a', 'debug', 'cloud', 'features', 'sandbox'];
  return subcommands.includes(first.toLowerCase());
}

const stripExt = (name: string) => name.replace(/\.(?:cmd|exe|ps1|bat)$/, '');
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PACKAGE_MANAGERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const PACKAGE_RUN_COMMANDS = new Set(['dlx', 'exec', 'x']);
const PASS_THROUGH = new Set(['env', 'exec', 'command', 'nohup', 'time']);

function resolveTokens(tokens: string[], ci: boolean, depth: number): InferredAgent | null {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { i++; continue; }
    const name = stripExt(baseName(token, true));
    if (PASS_THROUGH.has(name)) { i++; continue; }
    const fromPackage = (from: number): InferredAgent | null => {
      let j = from;
      while (j < tokens.length && (tokens[j].startsWith('-') || tokens[j] === '--')) j++;
      const agent = j < tokens.length ? packageAgent(tokens[j], ci) : null;
      return agent && !oneShot(agent, tokens.slice(j + 1)) ? agent : null;
    };
    if (name === 'cmd') {
      const flag = tokens.findIndex((t, k) => k > i && /^\/[ck]$/i.test(t));
      return flag < 0 || depth >= 3 ? null : resolveTokens(tokenize(tokens.slice(flag + 1).join(' ')), ci, depth + 1);
    }
    if (PACKAGE_RUNNERS.has(name)) return fromPackage(i + 1);
    if (PACKAGE_MANAGERS.has(name)) return PACKAGE_RUN_COMMANDS.has((tokens[i + 1] ?? '').toLowerCase()) ? fromPackage(i + 2) : null;
    const agent = executableAgent(token, ci);
    return agent && !oneShot(agent, tokens.slice(i + 1)) ? agent : null;
  }
  return null;
}

/**
 * The agent that a submitted shell command line starts, or null. The last command of a chain (`cd app && claude`) and the
 * last line of a pasted block decide, because that is the one still running. `caseInsensitive` is true where the shell finds
 * `Claude` too (Windows).
 */
export function commandLineAgent(line: string, caseInsensitive = true): InferredAgent | null {
  const lines = line.split('\n').filter((l) => l.trim());
  const last = lines[lines.length - 1];
  if (!last) return null;
  const segments = splitSegments(last).filter((s) => s.trim());
  const segment = segments[segments.length - 1];
  return segment ? resolveTokens(tokenize(segment), caseInsensitive, 0) : null;
}

// ── prompts on the screen ────────────────────────────────────────────────────

const PS_PROMPT = /^PS ([^>\r\n]*)>(?: (.*))?$/;
const CMD_PROMPT = /^([A-Za-z]:\\[^>\r\n]*)>(.*)$/;
const POSIX_PROMPT = /^(?:\([^)\r\n]*\) )?[\w.-]+@[\w.-]+[: ][^\r\n$#%]*[$#%](?: (.*))?$/;

export interface PromptLine { /** What follows the prompt (the typed command). */ command: string; /** The folder the prompt names, when it is an absolute path. */ cwd: string | null }

const absoluteDir = (path: string) => (/^(?:[A-Za-z]:\\|\/)/.test(path) ? path : null);

/** A recognised shell prompt (PowerShell, cmd, bash/zsh with user@host) at the start of a screen line, or null. */
export function parsePrompt(text: string): PromptLine | null {
  const ps = PS_PROMPT.exec(text);
  if (ps) return { command: ps[2] ?? '', cwd: absoluteDir(ps[1]) };
  const cmd = CMD_PROMPT.exec(text);
  if (cmd) return { command: cmd[2], cwd: cmd[1] };
  const posix = POSIX_PROMPT.exec(text);
  return posix ? { command: posix[1] ?? '', cwd: null } : null;
}

/** The command on a screen line: after a recognised prompt, else after the first prompt-like marker (never from TUI box lines). */
export function commandFromScreenLine(text: string): string | null {
  const prompt = parsePrompt(text);
  if (prompt) return prompt.command;
  if (/[│┃╭╮╰╯]/.test(text)) return null;
  const generic = /^[^>$#%❯]{2,}?[>$#%❯]\s+(.*)$/.exec(text);
  return generic ? generic[1] : null;
}

/** Titles that name a shell: seen after an agent started, they say the shell took the terminal back. */
const SHELL_TITLE = /(?:^|[\\/ ])(?:Windows PowerShell|PowerShell|pwsh|powershell|cmd|Command Prompt|bash|zsh)(?:\.exe)?$/i;

// ── keys ─────────────────────────────────────────────────────────────────────

export interface KeyLike { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }

/** The bytes a terminal would send for a key, for the cases where the app encodes keys itself (win32 input mode). '' = nothing. */
export function keySequence(ev: KeyLike): string {
  const { key } = ev;
  if (ev.metaKey) return '';
  if (ev.ctrlKey && !ev.altKey) {
    if (key === 'Backspace') return '\x17';
    if (key.length === 1 && /[a-z]/i.test(key)) return String.fromCharCode(key.toLowerCase().charCodeAt(0) - 96);
    return '';
  }
  if (ev.altKey) return key.length === 1 || key === 'Backspace' ? `\x1b${key.length === 1 ? key : '\x7f'}` : '';
  switch (key) {
    case 'Enter': return '\r';
    case 'Backspace': return '\x7f';
    case 'Escape': return '\x1b';
    case 'Tab': return '\t';
    case 'ArrowLeft': return '\x1b[D';
    case 'ArrowRight': return '\x1b[C';
    case 'ArrowUp': return '\x1b[A';
    case 'ArrowDown': return '\x1b[B';
    case 'Home': return '\x1b[H';
    case 'End': return '\x1b[F';
    case 'Delete': return '\x1b[3~';
    default: return [...key].length === 1 ? key : '';
  }
}

// ── the state machine ────────────────────────────────────────────────────────

/** The cursor's logical screen line (wrapped rows joined; `row` is where it starts), null in a full-screen program. */
export interface ScreenLine { text: string; row: number }
export interface ScreenState { line: ScreenLine | null; /** Alternate buffer on. */ alternate: boolean; /** Mouse tracking on. */ mouse: boolean }

export class AgentInference {
  /** The agent believed to run in the cell right now. */
  agent: InferredAgent | null = null;
  /** The folder it was started in, when the prompt (or the shell's cwd report) named one. */
  cwd: string | null = null;

  private line = '';
  private cursor = 0;
  /** The buffer cannot be trusted (history, completion, search): the screen decides at Enter. */
  private dirty = false;
  private inPaste = false;
  private reportedCwd: string | null = null;
  private startedAt = 0;
  private submitRow = -1;
  private tuiSeen = false;
  private lastOutput = 0;
  private promptRow: number | null = null;
  private promptSince = 0;
  private titleShellAt: number | null = null;

  constructor(private readonly caseInsensitive = true) {}

  /** Characters the user typed or pasted, as the terminal sends them to the pty (or built by `keySequence`). */
  input(data: string, now: number, screen?: () => ScreenLine | null): void {
    let i = 0;
    while (i < data.length) {
      if (this.inPaste) {
        const end = data.indexOf(PASTE_END, i);
        this.paste(end < 0 ? data.slice(i) : data.slice(i, end));
        if (end < 0) return;
        this.inPaste = false;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = data[i];
      if (ch === '\x1b') { i = this.escape(data, i); continue; }
      i++;
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && data[i] === '\n') i++;
        this.submit(now, screen);
      } else if (ch === '\x7f' || ch === '\b') this.backspace();
      else if (ch === '\x03' || ch === '\x15') this.resetLine();
      else if (ch === '\x01') this.cursor = 0;
      else if (ch === '\x05') this.cursor = this.line.length;
      else if (ch === '\x02') this.cursor = Math.max(0, this.cursor - 1);
      else if (ch === '\x06') this.cursor = Math.min(this.line.length, this.cursor + 1);
      else if (ch === '\x0b') this.line = this.line.slice(0, this.cursor);
      else if (ch === '\x17') this.deleteWord();
      else if (ch === '\x04') this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
      else if (ch === '\x0c' || ch === '\x16') continue;
      else if (ch < ' ' || (ch >= '\x7f' && ch <= '\x9f')) this.dirty = true; // tab (completion), history, search...
      else this.insert(ch);
    }
  }

  /** Live pty output arrived. */
  output(now: number): void {
    this.lastOutput = now;
  }

  /** The terminal title changed. */
  title(text: string, now: number): void {
    if (!this.agent) return;
    this.titleShellAt = SHELL_TITLE.test(text.trim()) && now - this.startedAt > 300 ? now : null;
  }

  /** The shell reported its folder (OSC 9;9). */
  reportCwd(path: string): void {
    this.reportedCwd = absoluteDir(path.replace(/^"(.*)"$/, '$1'));
  }

  /** The pty exited or was respawned: nothing is known any more. */
  exited(): void {
    this.clear();
    this.resetLine();
    this.inPaste = false;
    this.reportedCwd = null;
    this.lastOutput = 0;
  }

  /**
   * Looks at the screen while an agent is believed to run: a shell prompt that came back (a new line, or after the TUI was seen)
   * and stayed on a quiet screen for PROMPT_STABLE_MS, or a shell title that did, clears the guess. True when it did.
   */
  observe(now: number, screen: ScreenState | null): boolean {
    if (!this.agent || !screen) return false;
    if (screen.alternate || screen.mouse) {
      this.tuiSeen = true;
      this.promptRow = null;
      this.titleShellAt = null;
      return false;
    }
    const quietSince = (since: number) => now - Math.max(since, this.lastOutput) >= PROMPT_STABLE_MS;
    if (this.titleShellAt !== null && quietSince(this.titleShellAt)) return this.clear();
    const row = screen.line && parsePrompt(screen.line.text) && (screen.line.row !== this.submitRow || this.tuiSeen) ? screen.line.row : null;
    if (row === null) {
      this.promptRow = null;
      return false;
    }
    if (this.promptRow !== row) {
      this.promptRow = row;
      this.promptSince = now;
    }
    return quietSince(this.promptSince) ? this.clear() : false;
  }

  private clear(): boolean {
    const had = this.agent !== null;
    this.agent = null;
    this.cwd = null;
    this.tuiSeen = false;
    this.promptRow = null;
    this.titleShellAt = null;
    return had;
  }

  private start(agent: InferredAgent, now: number, cwd: string | null, row: number): void {
    this.clear();
    this.agent = agent;
    this.cwd = cwd ?? this.reportedCwd;
    this.startedAt = now;
    this.submitRow = row;
  }

  private submit(now: number, screen?: () => ScreenLine | null): void {
    const typed = this.line;
    const wasDirty = this.dirty;
    this.resetLine();
    if (!wasDirty && !typed.trim()) return;
    const onScreen = screen?.() ?? null; // the prompt names the folder; with a dirty buffer it also holds the command
    const prompt = onScreen ? parsePrompt(onScreen.text) : null;
    // Lines typed inside a running agent are its input, not shell commands: only a line at a visible shell prompt counts.
    if (this.agent && !prompt) return;
    const command = wasDirty ? (onScreen ? commandFromScreenLine(onScreen.text) : null) : typed;
    if (command === null) return;
    const agent = commandLineAgent(command, this.caseInsensitive);
    if (agent) this.start(agent, now, prompt?.cwd ?? null, onScreen?.row ?? -1);
    else if (this.agent) this.clear();
  }

  private resetLine(): void {
    this.line = '';
    this.cursor = 0;
    this.dirty = false;
  }

  private insert(text: string): void {
    const room = MAX_LINE - this.line.length;
    if (room <= 0) return;
    const part = text.slice(0, room);
    this.line = this.line.slice(0, this.cursor) + part + this.line.slice(this.cursor);
    this.cursor += part.length;
  }

  private paste(text: string): void {
    this.insert(text.replace(/\r\n|\r/g, '\n').replace(/\t/g, ' ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ''));
  }

  private backspace(): void {
    if (this.cursor <= 0) return;
    this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
    this.cursor--;
  }

  private deleteWord(): void {
    const before = this.line.slice(0, this.cursor).replace(/\s*\S*$/, '');
    this.line = before + this.line.slice(this.cursor);
    this.cursor = before.length;
  }

  /** Handles the escape sequence at `i`; returns the index after it. */
  private escape(data: string, i: number): number {
    if (data.startsWith(PASTE_START, i)) {
      this.inPaste = true;
      return i + PASTE_START.length;
    }
    const next = data[i + 1];
    if (next === undefined) { // a lone Esc clears the line
      this.resetLine();
      return i + 1;
    }
    if (next === '[') {
      let j = i + 2;
      while (j < data.length && data.charCodeAt(j) >= 0x30 && data.charCodeAt(j) <= 0x3f) j++;
      while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x2f) j++;
      const params = data.slice(i + 2, j);
      const final = data[j];
      if (final === undefined) return data.length;
      this.cursorKey(final, params);
      return final === 'M' && !params ? Math.min(data.length, j + 4) : j + 1; // an X10 mouse report carries three more bytes
    }
    if (next === 'O' && i + 2 < data.length) {
      this.cursorKey(data[i + 2], '');
      return i + 3;
    }
    if (next === ']' || next === 'P') { // a device reply: skip it whole
      const bel = data.indexOf('\x07', i);
      const st = data.indexOf('\x1b\\', i + 2);
      const end = [bel < 0 ? Infinity : bel + 1, st < 0 ? Infinity : st + 2].reduce((a, b) => Math.min(a, b));
      return end === Infinity ? data.length : end;
    }
    this.dirty = true; // Alt+key
    return i + 2;
  }

  private cursorKey(final: string, params: string): void {
    if (!'ABCDHF~'.includes(final) || /^[<?>=]/.test(params)) return; // focus and mouse reports, device replies, page keys
    // Modified keys (Ctrl+Arrow, Shift+Home) move by words or select: the buffer position is unknown from here on.
    if (params.includes(';')) { this.dirty = true; return; }
    const count = Math.max(1, parseInt(params, 10) || 1);
    switch (final) {
      case 'D': this.cursor = Math.max(0, this.cursor - count); break;
      case 'C': this.cursor = Math.min(this.line.length, this.cursor + count); break;
      case 'H': this.cursor = 0; break;
      case 'F': this.cursor = this.line.length; break;
      case 'A': case 'B': this.dirty = true; break; // history
      case '~':
        if (params === '1' || params === '7') this.cursor = 0;
        else if (params === '4' || params === '8') this.cursor = this.line.length;
        else if (params === '3') this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        break;
      default: break; // focus and mouse reports, device replies, page keys
    }
  }
}
