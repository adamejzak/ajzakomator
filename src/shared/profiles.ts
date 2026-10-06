import type { Profile, ShellKind } from './types';

export const DEFAULT_PROFILES: Profile[] = [
  { id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' },
  { id: 'claude-opus', name: 'Claude Opus', cli: 'claude', args: '--model opus', color: '#e0a080' },
  { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' },
  { id: 'codex-high', name: 'Codex high', cli: 'codex', args: '-c model_reasoning_effort=high', color: '#4fd1a5' },
  { id: 'shell', name: 'PowerShell', cli: 'shell', args: '', color: '#7a7a7a' },
];

/** PowerShell single-quoted literal. */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Quotes a path for the cell's shell (cmd has no single-quote strings). */
export const shellQuote = (s: string, shell: ShellKind = 'pwsh') => (shell === 'cmd' ? `"${s}"` : psQuote(s));

export interface LaunchOptions {
  mode: 'new' | 'resume';
  sessionId?: string;
  /** Per-cell Claude settings file carrying our status hooks. */
  claudeSettingsPath?: string;
  shell?: ShellKind;
}

/** Command typed into the cell's shell to start the agent; null for plain shell profiles. */
export function buildLaunchCommand(profile: Profile, opts: LaunchOptions): string | null {
  const args = profile.args.trim();
  const parts: string[] = [];
  if (profile.cli === 'claude') {
    parts.push('claude');
    if (opts.sessionId) parts.push(opts.mode === 'resume' ? '--resume' : '--session-id', opts.sessionId);
    if (opts.claudeSettingsPath) parts.push('--settings', shellQuote(opts.claudeSettingsPath, opts.shell));
  } else if (profile.cli === 'codex') {
    parts.push('codex');
    if (opts.mode === 'resume' && opts.sessionId) parts.push('resume', opts.sessionId);
    parts.push('-c', 'tui.notifications=true');
  } else {
    return null;
  }
  if (args) parts.push(args);
  return parts.join(' ');
}
