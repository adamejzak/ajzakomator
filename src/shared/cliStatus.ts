// Pure helpers for finding the agent CLIs (Claude Code, Codex): types, official install data,
// PATH arithmetic and the "may this cell start?" decision. No I/O, so everything is unit-tested.
import type { Profile } from './types';

export type CliId = 'claude' | 'codex';
export const CLI_IDS: readonly CliId[] = ['claude', 'codex'];
export const isCliId = (value: unknown): value is CliId => value === 'claude' || value === 'codex';

/** Display names (proper nouns, never translated). */
export const CLI_NAMES: Record<CliId, string> = { claude: 'Claude Code', codex: 'Codex' };

export type CliState = 'found' | 'missing' | 'unknown';
export type CliReason = 'notOnPath' | 'versionFailed' | 'timeout' | 'probeFailed' | 'registryFailed';
export type CliSource = 'known' | 'path' | 'shell';

export interface CliStatus {
  cli: CliId;
  /** `unknown` = detection failed or timed out; it never blocks a spawn. */
  state: CliState;
  path?: string;
  version?: string;
  source?: CliSource;
  reason?: CliReason;
  checkedAt: number;
}
export type CliStatusMap = Partial<Record<CliId, CliStatus>>;

// ── official documentation and install commands (allow-list; the renderer only ever sends a CliId) ──

export const CLI_DOCS: Record<CliId, string> = {
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://github.com/openai/codex',
};
export const docsUrl = (cli: CliId): string => CLI_DOCS[cli];

export type InstallMethod = 'native' | 'npm' | 'brew' | 'winget';
export type InstallPlatform = 'win32' | 'darwin' | 'linux';

/** Exact official commands (verified against the vendors' documentation); null = not offered on that platform. */
const INSTALL: Record<CliId, Record<InstallMethod, { win32: string | null; posix: string | null }>> = {
  claude: {
    native: { win32: 'irm https://claude.ai/install.ps1 | iex', posix: 'curl -fsSL https://claude.ai/install.sh | bash' },
    npm: { win32: 'npm install -g @anthropic-ai/claude-code', posix: 'npm install -g @anthropic-ai/claude-code' },
    brew: { win32: null, posix: 'brew install --cask claude-code' },
    winget: { win32: 'winget install Anthropic.ClaudeCode', posix: null },
  },
  codex: {
    native: { win32: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', posix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
    npm: { win32: 'npm install -g @openai/codex', posix: 'npm install -g @openai/codex' },
    brew: { win32: null, posix: 'brew install --cask codex' },
    winget: { win32: null, posix: null },
  },
};

export function installCommand(cli: CliId, platform: InstallPlatform, method: InstallMethod): string | null {
  return INSTALL[cli][method][platform === 'win32' ? 'win32' : 'posix'];
}

/** Methods the vendors document for a platform, the recommended one first. */
export function installMethods(cli: CliId, platform: InstallPlatform): InstallMethod[] {
  return (['native', 'npm', 'brew', 'winget'] as const).filter((method) => installCommand(cli, platform, method) !== null);
}

// ── profiles ─────────────────────────────────────────────────────────────────

/** Profiles run a fixed binary chosen by their `cli`; shell profiles never need one. */
export function cliForProfile(profile: Pick<Profile, 'cli'>): CliId | null {
  return profile.cli === 'claude' || profile.cli === 'codex' ? profile.cli : null;
}

/** The CLI a profile needs when it is known to be missing (unknown or not yet checked counts as available). */
export function missingCli(profile: Pick<Profile, 'cli'>, map: CliStatusMap | undefined): CliId | null {
  const cli = cliForProfile(profile);
  return cli && map?.[cli]?.state === 'missing' ? cli : null;
}

export const profileAvailable = (profile: Pick<Profile, 'cli'>, map: CliStatusMap | undefined): boolean => missingCli(profile, map) === null;

export type SpawnDecision = { spawn: true } | { spawn: false; cli: CliId };

/** Fail open: only a definite "missing" blocks a spawn. */
export function spawnDecision(profile: Pick<Profile, 'cli'>, status: CliStatus | undefined): SpawnDecision {
  const cli = cliForProfile(profile);
  return cli && status?.state === 'missing' ? { spawn: false, cli } : { spawn: true };
}

/** Distinct missing CLIs among the given profiles (for the new-grid warning). */
export function missingClis(profiles: Array<Pick<Profile, 'cli'>>, map: CliStatusMap | undefined): CliId[] {
  const out: CliId[] = [];
  for (const profile of profiles) {
    const cli = missingCli(profile, map);
    if (cli && !out.includes(cli)) out.push(cli);
  }
  return out;
}

export function sameStatus(a: CliStatus | undefined, b: CliStatus | undefined): boolean {
  return a?.state === b?.state && a?.path === b?.path && a?.version === b?.version;
}

// ── version ──────────────────────────────────────────────────────────────────

/** `2.1.211 (Claude Code)` / `codex-cli 0.5.0` -> the first x.y.z. Never returns anything else from the output. */
export function parseVersion(text: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(text)?.[1];
}

// ── PATH arithmetic ──────────────────────────────────────────────────────────

const pathDelimiter = (platform: string) => (platform === 'win32' ? ';' : ':');
const samePathEntry = (platform: string, a: string, b: string) => {
  const norm = (value: string) => {
    const cut = value.replace(/[\\/]+$/, '');
    return platform === 'win32' ? cut.replace(/\//g, '\\').toLowerCase() : cut;
  };
  return norm(a) === norm(b);
};

export function splitPath(value: string | undefined, platform: string): string[] {
  if (!value) return [];
  return value.split(pathDelimiter(platform)).map((part) => part.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

export function joinPath(entries: string[], platform: string): string {
  return entries.join(pathDelimiter(platform));
}

export const pathHas = (entries: string[], dir: string, platform: string): boolean => entries.some((entry) => samePathEntry(platform, entry, dir));

/** Keeps `base` order and appends the extras it does not contain yet. */
export function mergePaths(base: string[], extras: string[], platform: string): string[] {
  const out = [...base];
  for (const extra of extras) if (!pathHas(out, extra, platform)) out.push(extra);
  return out;
}

/** Puts `dir` first unless the PATH already has it (then the order the user set up is kept). */
export function prependDir(entries: string[], dir: string, platform: string): string[] {
  return pathHas(entries, dir, platform) ? entries : [dir, ...entries];
}

/** Environment variables are case-insensitive on Windows; returns the actual key (`Path`, `PATH`) or undefined. */
export function findEnvKey(env: Record<string, unknown>, name: string, platform: string): string | undefined {
  if (platform !== 'win32') return Object.hasOwn(env, name) ? name : undefined;
  const lower = name.toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lower);
}

export function getEnv(env: Record<string, string | undefined>, name: string, platform: string): string | undefined {
  const key = findEnvKey(env, name, platform);
  return key === undefined ? undefined : env[key];
}

/** Sets PATH under the key the environment already uses (a second `PATH` next to `Path` confuses Windows). */
export function withPath(env: Record<string, string>, value: string, platform: string): Record<string, string> {
  const key = findEnvKey(env, 'PATH', platform) ?? 'PATH';
  return { ...env, [key]: value };
}

/** Expands `%NAME%` (Windows registry REG_EXPAND_SZ values). Unknown variables stay untouched. */
export function expandWindowsVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/%([^%]+)%/g, (token, name: string) => getEnv(env, name, 'win32') ?? token);
}

/** Machine entries first, then user ones - the order Windows builds a process PATH in. */
export function registryPathEntries(raw: { machine?: string | null; user?: string | null }, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const part of [raw.machine, raw.user]) {
    for (const entry of splitPath(part ? expandWindowsVars(part, env) : '', 'win32')) {
      if (/%[^%]+%/.test(entry)) continue; // unresolved variable: not a usable directory
      if (!pathHas(out, entry, 'win32')) out.push(entry);
    }
  }
  return out;
}

/** Parses `reg query <key> /v Path` output (`    Path    REG_EXPAND_SZ    C:\a;C:\b`). */
export function parseRegQueryPath(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/i.exec(line);
    if (match) return match[1];
  }
  return null;
}

// ── known install locations ──────────────────────────────────────────────────

const joinFor = (platform: string, ...parts: string[]) => {
  const sep = platform === 'win32' ? '\\' : '/';
  return parts.map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep);
};

/** Directories where the documented installers and common version managers put `claude` / `codex`. */
export function knownCliDirs(platform: string, env: Record<string, string | undefined>, home: string): string[] {
  const j = (...parts: string[]) => joinFor(platform, ...parts);
  if (platform === 'win32') {
    const appData = getEnv(env, 'APPDATA', 'win32') || j(home, 'AppData', 'Roaming');
    const local = getEnv(env, 'LOCALAPPDATA', 'win32') || j(home, 'AppData', 'Local');
    const programFiles = getEnv(env, 'ProgramFiles', 'win32');
    const programData = getEnv(env, 'ProgramData', 'win32');
    return [
      j(home, '.local', 'bin'),
      j(home, '.claude', 'local'),
      j(appData, 'npm'),
      j(local, 'Microsoft', 'WinGet', 'Links'),
      j(home, 'scoop', 'shims'),
      ...(programFiles ? [j(programFiles, 'nodejs')] : []),
      j(local, 'Volta', 'bin'),
      j(home, '.bun', 'bin'),
      j(local, 'pnpm'),
      ...(programData ? [j(programData, 'chocolatey', 'bin')] : []),
    ];
  }
  return [
    j(home, '.local', 'bin'),
    j(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    j(home, '.npm-global', 'bin'),
    j(home, '.bun', 'bin'),
    j(home, '.volta', 'bin'),
    j(home, '.asdf', 'shims'),
    j(home, '.local', 'share', 'mise', 'shims'),
    j(home, '.local', 'share', 'pnpm'),
    j(home, 'Library', 'pnpm'),
    '/home/linuxbrew/.linuxbrew/bin',
  ];
}

/** Version-manager layouts: `<root>/<version>/<suffix>` (the newest version is tried first). */
export function versionedCliDirs(platform: string, home: string): Array<{ root: string; suffix: string }> {
  if (platform === 'win32') {
    return [
      { root: joinFor(platform, home, 'AppData', 'Roaming', 'nvm'), suffix: '' },
      { root: joinFor(platform, home, 'AppData', 'Local', 'fnm', 'node-versions'), suffix: 'installation' },
    ];
  }
  return [
    { root: joinFor(platform, home, '.nvm', 'versions', 'node'), suffix: 'bin' },
    { root: joinFor(platform, home, '.local', 'share', 'fnm', 'node-versions'), suffix: 'installation/bin' },
    { root: joinFor(platform, home, 'Library', 'Application Support', 'fnm', 'node-versions'), suffix: 'installation/bin' },
  ];
}

/** Newest semver first; non-version names last. */
export function sortVersionsDesc(names: string[]): string[] {
  const key = (name: string) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(name) ?? []).slice(1).map(Number);
  return [...names].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (!ka.length || !kb.length) return ka.length ? -1 : kb.length ? 1 : a.localeCompare(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
}

/** `prefix=...` of ~/.npmrc, resolved to its executables directory (null when absent). */
export function npmPrefixBinDir(npmrc: string, platform: string, home: string): string | null {
  for (const line of npmrc.split(/\r?\n/)) {
    const match = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const prefix = match[1].replace(/^["']|["']$/g, '').replace(/^~(?=[\\/]|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
    if (!prefix || prefix.includes('${')) return null;
    return platform === 'win32' ? prefix : `${prefix.replace(/\/+$/, '')}/bin`;
  }
  return null;
}

/** File names to look for in a directory. Windows follows PATHEXT (`.exe` first), POSIX is the bare name. */
export function executableNames(cli: CliId, platform: string, pathExt?: string): string[] {
  if (platform !== 'win32') return [cli];
  const exts = (pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => /^\.[a-z0-9]{1,5}$/.test(e));
  const wanted = [...new Set(['.exe', ...exts, '.cmd'])].filter((e) => e !== '.ps1' && e !== '.vbs' && e !== '.js');
  return wanted.map((ext) => `${cli}${ext}`);
}

/** Parses the marker lines printed by the login-shell probe; rc-file noise around them is ignored. */
export function parseShellProbe(output: string): { path: string[]; found: Partial<Record<CliId, string>> } {
  let path: string[] = [];
  const found: Partial<Record<CliId, string>> = {};
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
    if (line.startsWith('__AJZ_PATH__=')) path = splitPath(line.slice('__AJZ_PATH__='.length), 'linux').filter((dir) => dir.startsWith('/'));
    for (const cli of CLI_IDS) {
      const prefix = `__AJZ_${cli.toUpperCase()}__=`;
      if (!line.startsWith(prefix)) continue;
      const value = line.slice(prefix.length).trim();
      // `command -v` also prints aliases and function names; only absolute file paths count.
      if (value.startsWith('/')) found[cli] = value;
    }
  }
  return { path, found };
}

/** The script run by `$SHELL -ilc`; POSIX shells and fish only. null = unsupported shell (no probe). */
export function shellProbeScript(shellPath: string): string | null {
  const name = shellPath.split('/').pop() ?? '';
  if (name === 'fish') {
    return "printf '__AJZ_PATH__=%s\\n' (string join : $PATH); printf '__AJZ_CLAUDE__=%s\\n' (command -v claude); printf '__AJZ_CODEX__=%s\\n' (command -v codex)";
  }
  if (!['zsh', 'bash', 'sh', 'dash', 'ksh'].includes(name)) return null;
  return "printf '__AJZ_PATH__=%s\\n' \"$PATH\"; printf '__AJZ_CLAUDE__=%s\\n' \"$(command -v claude 2>/dev/null)\"; printf '__AJZ_CODEX__=%s\\n' \"$(command -v codex 2>/dev/null)\"";
}
