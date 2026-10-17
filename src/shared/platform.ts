import type { ShellKind } from './types';

export type AppPlatform = 'win32' | 'darwin' | 'linux';

export function appPlatform(platform: string): AppPlatform {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}

export function shellsForPlatform(platform: AppPlatform): ReadonlyArray<{ code: ShellKind; name: string }> {
  return platform === 'win32' ? [
    { code: 'pwsh', name: 'PowerShell 7 (pwsh)' },
    { code: 'powershell', name: 'Windows PowerShell 5' },
    { code: 'cmd', name: 'cmd' },
  ] : [
    { code: 'zsh', name: 'zsh' },
    { code: 'bash', name: 'bash' },
  ];
}

export function defaultShell(platform: AppPlatform): ShellKind {
  return platform === 'win32' ? 'pwsh' : platform === 'darwin' ? 'zsh' : 'bash';
}

export function shortcutLabel(platform: AppPlatform, value: string): string {
  return platform === 'darwin' ? value.replace(/\bCtrl(?=\+)/g, 'Cmd').replace(/\bAlt(?=\+)/g, 'Option') : value;
}

export function fullProjectPath(root: string, relative: string, platform: AppPlatform): string {
  const separator = platform === 'win32' ? '\\' : '/';
  return relative ? `${root.replace(/[\\/]+$/, '')}${separator}${relative.replace(/[\\/]/g, separator)}` : root;
}

/** Windows paths are case-insensitive; Unix paths may belong to a case-sensitive volume. */
export function normalizeProjectPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

/** The sandboxed preload has no `os` module: main passes the Windows build number on the renderer's command line. */
export const WINDOWS_BUILD_ARG = '--mc-windows-build=';

/** Windows build number from `os.release()` ("10.0.26200" -> 26200); 0 on other systems or when it cannot be read. */
export function windowsBuildFromRelease(platform: string, release: string): number {
  return platform === 'win32' ? Number(release.split('.')[2]) || 0 : 0;
}

/** The build number main put into `additionalArguments` (0 when missing or malformed). */
export function windowsBuildFromArgv(argv: readonly string[]): number {
  const arg = argv.find((value) => value.startsWith(WINDOWS_BUILD_ARG));
  const build = arg ? Number(arg.slice(WINDOWS_BUILD_ARG.length)) : 0;
  return Number.isInteger(build) && build > 0 ? build : 0;
}
