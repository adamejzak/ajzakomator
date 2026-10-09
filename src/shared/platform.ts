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
