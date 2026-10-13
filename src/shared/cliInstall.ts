// Pure helpers of the guided CLI install: which methods can work here, the exact command typed into the
// terminal (per shell), the end marker that reports the exit code, and the mapping of failures to a coarse
// reason. No I/O, so everything is unit-tested. The renderer never supplies a command, only {cli, method}.
import { installCommand, isCliId, parseVersion, type CliId, type InstallMethod, type InstallPlatform } from './cliStatus';
import type { ShellKind } from './types';

export const INSTALL_METHODS: readonly InstallMethod[] = ['native', 'winget', 'brew', 'npm'];
export const isInstallMethod = (value: unknown): value is InstallMethod => typeof value === 'string' && (INSTALL_METHODS as readonly string[]).includes(value);

/** Ptys of the install window start with this prefix; they are not cells and are never status-tracked. */
export const INSTALL_PTY_PREFIX = 'install:';
/** Login (`auth:`) and install (`install:`) terminals are windows of the app, not cells. */
export const isAuxPtyId = (id: string): boolean => id.startsWith('auth:') || id.startsWith(INSTALL_PTY_PREFIX);

export type InstallReason = 'network' | 'proxy' | 'permission' | 'npmMissing' | 'policy' | 'notOnPath' | 'timeout' | 'generic';
export const INSTALL_REASONS: readonly InstallReason[] = ['network', 'proxy', 'permission', 'npmMissing', 'policy', 'notOnPath', 'timeout', 'generic'];

export interface InstallRequest { cli: CliId; method: InstallMethod }

/** Progress pushed to the renderer on `install:state`. `dir` is the folder the CLI is expected in / was found in. */
export type InstallState =
  | { sessionId: string; status: 'running' }
  | { sessionId: string; status: 'succeeded'; version?: string; path?: string; dir?: string }
  | { sessionId: string; status: 'failed'; reason: InstallReason; exitCode?: number; dir?: string };

export interface InstallOption {
  method: InstallMethod;
  /** Exactly what will be typed into the terminal (without the end marker). */
  command: string;
}
export interface InstallOptions {
  cli: CliId;
  options: InstallOption[];
  /** Detected Node.js version (npm method), without the leading "v". */
  nodeVersion?: string;
}
export type InstallStartResult =
  | { ok: true; sessionId: string; ptyId: string; command: string }
  | { ok: false; error: 'invalid' | 'busy' | 'unavailable' | 'spawn' };

// ── prerequisites ────────────────────────────────────────────────────────────

export interface InstallTools { winget: boolean; brew: boolean; npm: boolean; node: boolean; curl: boolean; nodeVersion?: string }
export const NO_TOOLS: InstallTools = { winget: false, brew: false, npm: false, node: false, curl: false };

/** Methods that can work on this machine, the recommended one first. Impossible combinations are never listed. */
export function availableMethods(cli: CliId, platform: InstallPlatform, tools: InstallTools): InstallMethod[] {
  return INSTALL_METHODS.filter((method) => {
    if (installCommand(cli, platform, method) === null) return false;
    if (method === 'native') return platform === 'win32' || tools.curl;
    if (method === 'winget') return platform === 'win32' && tools.winget;
    if (method === 'brew') return platform === 'darwin' && tools.brew;
    return tools.npm && tools.node;
  });
}

/** `22` for `v22.3.0`; undefined when unparsable. */
export function nodeMajor(version: string | undefined): number | undefined {
  const parsed = version ? parseVersion(version.replace(/^v/i, '')) : undefined;
  return parsed ? Number(parsed.split('.')[0]) : undefined;
}
/** Claude Code installed through npm needs Node.js 22+. */
export const NPM_NODE_MIN = 22;

// ── commands per shell ───────────────────────────────────────────────────────

export type ShellFamily = 'powershell' | 'cmd' | 'posix';
export function shellFamily(shell: ShellKind, platform: InstallPlatform): ShellFamily {
  if (platform !== 'win32') return 'posix';
  return shell === 'cmd' ? 'cmd' : 'powershell';
}

/** The command in the form the configured shell runs it. Null = impossible combination (allow-list). */
export function installCommandFor(cli: CliId, method: InstallMethod, platform: InstallPlatform, shell: ShellKind): string | null {
  if (!isCliId(cli) || !isInstallMethod(method)) return null;
  const official = installCommand(cli, platform, method);
  if (official === null) return null;
  const family = shellFamily(shell, platform);
  if (platform === 'win32') {
    // `irm ... | iex` is PowerShell syntax: from cmd.exe it runs in a one-off PowerShell (no policy change).
    if (family === 'cmd' && official.startsWith('irm ')) return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${official}"`;
    // `npm` resolves to npm.ps1 first in PowerShell, which a default execution policy blocks; npm.cmd is the same program.
    if (family === 'powershell' && method === 'npm') return official.replace(/^npm /, 'npm.cmd ');
  }
  return official;
}

/** Output prefix of the end marker; the typed command spells it in pieces so the echo of the command never matches. */
export const INSTALL_MARKER = '__AJZ_DONE__';

/**
 * Wraps the command so the shell prints `__AJZ_DONE__<exit code>` when it returns. PowerShell and cmd only know
 * success/failure (0 or 1); POSIX shells give the real code (a pipeline fails when any part fails).
 */
export function typedInstallCommand(command: string, family: ShellFamily): string {
  if (family === 'powershell') return `${command}; Write-Host ('__AJZ_DONE_' + '_' + [int](-not $?))`;
  if (family === 'cmd') return `${command} && echo __AJZ_DON^E__0 || echo __AJZ_DON^E__1`;
  return `(set -o pipefail; ${command}); echo "__AJZ_DONE_""_$?"`;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');

/** The exit code of the last marker in the output (ANSI stripped by this function), or null. */
export function parseInstallMarker(text: string): number | null {
  let code: number | null = null;
  const pattern = new RegExp(`${INSTALL_MARKER}(\\d{1,3})(?![0-9A-Za-z_])`, 'g');
  for (const match of stripAnsi(text).matchAll(pattern)) code = Number(match[1]);
  return code;
}

// ── failures ─────────────────────────────────────────────────────────────────

/** Coarse reason from the finished command; `installedButMissing` = it exited cleanly but the detector still finds nothing. */
export function classifyInstallFailure(input: { exitCode: number | null; output: string; method: InstallMethod; installedButMissing?: boolean; timedOut?: boolean }): InstallReason {
  if (input.timedOut) return 'timeout';
  const text = stripAnsi(input.output);
  if (input.installedButMissing && (input.exitCode === 0 || input.exitCode === null)) return 'notOnPath';
  if (/running scripts is disabled|cannot be loaded because running scripts|PSSecurityException|is not digitally signed|UnauthorizedAccess|AuthorizationManager|execution policy/i.test(text)) return 'policy';
  if (input.method === 'npm' && /'npm(?:\.cmd)?' is not recognized|npm(?:\.cmd)?\s*:\s*(?:the term|command not found|not found)|command not found: npm/i.test(text)) return 'npmMissing';
  if (/\b40[37]\b|forbidden|proxy authentication|<!doctype html|<html|blocked by (?:your )?(?:administrator|policy|proxy)/i.test(text)) return 'proxy';
  if (/\bEACCES\b|\bEPERM\b|permission denied|access is denied|operation not permitted|EACCES/i.test(text)) return 'permission';
  if (/could not resolve host|curl: \((?:6|7|18|22|28|35|52|56|60)\)|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network|unable to connect to the remote server|remote name could not be resolved|timed out|secure channel|SSL\/TLS|certificate|unable to get local issuer|Could not establish trust|connection (?:was )?(?:closed|reset|refused)|Invoke-RestMethod|Invoke-WebRequest|\b404\b|\b5\d\d\b.*(?:error|server)/i.test(text)) return 'network';
  return 'generic';
}

// ── expected location ────────────────────────────────────────────────────────

/** Where the method puts the binary (for the "not on PATH" hint and the PATH note); undefined when not documented. */
export function expectedBinDir(cli: CliId, method: InstallMethod, platform: InstallPlatform, home: string, env: Record<string, string | undefined>): string | undefined {
  const sep = platform === 'win32' ? '\\' : '/';
  const join = (...parts: string[]) => parts.map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep);
  if (method === 'native') return cli === 'claude' ? join(home, '.local', 'bin') : undefined;
  if (platform === 'win32') {
    if (method === 'npm') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm');
    if (method === 'winget') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links');
  }
  if (method === 'brew') return platform === 'darwin' ? '/opt/homebrew/bin' : undefined;
  return undefined;
}

// ── POSIX tool probe (login shell, so brew / nvm paths of the user's rc files count) ─────────────

const PROBE_TOOLS = ['brew', 'npm', 'node', 'curl'] as const;

/** Script for `$SHELL -ilc`; null = unsupported shell. Prints marker lines the parser below reads. */
export function toolProbeScript(shellPath: string): string | null {
  const name = shellPath.split('/').pop() ?? '';
  const list = PROBE_TOOLS.join(' ');
  if (name === 'fish') {
    return `for t in ${list}; printf '__AJZ_TOOL_%s__=%s\\n' $t (command -v $t); end; printf '__AJZ_NODEV__=%s\\n' (node --version 2>/dev/null)`;
  }
  if (!['zsh', 'bash', 'sh', 'dash', 'ksh'].includes(name)) return null;
  return `for t in ${list}; do printf '__AJZ_TOOL_%s__=%s\\n' "$t" "$(command -v "$t" 2>/dev/null)"; done; printf '__AJZ_NODEV__=%s\\n' "$(node --version 2>/dev/null)"`;
}

/** Marker lines -> tools; rc-file noise is ignored and only absolute paths count (aliases and functions do not). null = no marker at all (probe failed). */
export function parseToolProbe(output: string): InstallTools | null {
  const tools: InstallTools = { ...NO_TOOLS };
  let seen = false;
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const line = raw.trim();
    const tool = /^__AJZ_TOOL_(brew|npm|node|curl)__=(.*)$/.exec(line);
    if (tool) { seen = true; if (tool[2].trim().startsWith('/')) tools[tool[1] as (typeof PROBE_TOOLS)[number]] = true; continue; }
    const version = /^__AJZ_NODEV__=(.*)$/.exec(line);
    if (version) { const parsed = parseVersion(version[1].replace(/^v/i, '')); if (parsed) tools.nodeVersion = parsed; }
  }
  return seen ? tools : null;
}
