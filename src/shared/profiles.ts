import type { Profile, ShellKind } from './types';

export const DEFAULT_PROFILES: Profile[] = [
  { id: 'claude', name: 'Claude', cli: 'claude', args: '', color: '#d97757' },
  { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' },
  { id: 'shell', name: 'PowerShell', cli: 'shell', args: '', color: '#7a7a7a' },
];

/** Profiles shipped by earlier versions, folded into their base profile. */
export const RETIRED_PROFILES: Record<string, string> = { 'claude-opus': 'claude', 'codex-high': 'codex' };

/** PowerShell single-quoted literal. */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** POSIX shell single-quoted literal (bash/zsh). */
export const posixQuote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";

/** Quotes a path for the cell's shell (cmd has no single-quote strings). */
export const shellQuote = (s: string, shell: ShellKind = 'pwsh') =>
  shell === 'cmd' ? `"${s}"` : shell === 'zsh' || shell === 'bash' ? posixQuote(s) : psQuote(s);

export interface LaunchOptions {
  mode: 'new' | 'resume';
  sessionId?: string;
  /** Per-cell Claude settings file carrying our status hooks. */
  claudeSettingsPath?: string;
  shell?: ShellKind;
  /**
   * First prompt for a new conversation. PowerShell and POSIX shells read it from `file`
   * (keeping newlines and quotes intact); cmd gets the text inline on one line.
   */
  initialPrompt?: { file: string; text: string };
}

function promptArg(p: { file: string; text: string }, shell: ShellKind = 'pwsh'): string {
  if (shell === 'zsh' || shell === 'bash') return `"$(cat ${posixQuote(p.file)})"`;
  if (shell === 'cmd') return `"${p.text.replace(/\s+/g, ' ').replace(/"/g, "'").trim()}"`;
  return `(Get-Content -Raw -Encoding utf8 -LiteralPath ${psQuote(p.file)})`;
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
  if (opts.mode === 'new' && opts.initialPrompt?.text.trim()) parts.push(promptArg(opts.initialPrompt, opts.shell));
  return parts.join(' ');
}
