/** Limits of the user's Claude and Codex accounts: types and pure helpers shared by main process and window. */
export type UsageProvider = 'claude' | 'codex';
export type UsageStatus = 'ok' | 'signedOut' | 'expired' | 'dormant' | 'apiKey' | 'error';
/* `dormant`: the main Claude login's access token is past its expiry but a refresh token exists; Claude Code renews it on next use. Not an error. */
export type UsageSource = 'live' | 'log' | 'cache';

export interface UsageWindow {
  id: '5h' | '7d';
  /** 0 to 100 as reported when the data was read. */
  usedPercent: number;
  /** Epoch seconds when the window resets; 0 when the provider reports no active window. */
  resetsAt: number;
}

/** One account whose limits are tracked; `configDir` is set for a managed Claude profile and absent for the main login. */
export interface AccountRef {
  id: string;
  provider: UsageProvider;
  configDir?: string;
}

export const MAIN_ACCOUNTS: AccountRef[] = [
  { id: 'claude:main', provider: 'claude' },
  { id: 'codex:main', provider: 'codex' },
];

export interface ProviderUsage {
  accountId: string;
  provider: UsageProvider;
  status: UsageStatus;
  plan?: string;
  email?: string;
  org?: string;
  /** The account lives in an isolated profile managed by this app. */
  managed?: boolean;
  windows: UsageWindow[];
  /** Epoch milliseconds of the read this data comes from. */
  fetchedAt: number;
  source: UsageSource;
  /** Short machine-readable reason (for example `http-429`, `refresh-http-429`, `bad-response`); never a token. */
  error?: string;
  /** Epoch milliseconds of the last attempt to read this account (fetchedAt stays the time of the last good data). */
  attemptAt?: number;
  /** Epoch milliseconds before which the service will not try again after a failure. */
  retryAt?: number;
  /** A saved account that holds the very same login as the main one: its limits are read through the main login and its tokens are never renewed here. */
  shared?: boolean;
}

export interface UsageState { providers: ProviderUsage[] }

export const USAGE_INTERVALS_MINUTES = [1, 5, 15] as const;

export type UsageBand = 'low' | 'mid' | 'high';

export const clampPercent = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

/** A window that already reset counts as unused until fresh data arrives. */
export function effectivePercent(window: UsageWindow, nowMs: number): number {
  return window.resetsAt > 0 && window.resetsAt * 1000 <= nowMs ? 0 : clampPercent(window.usedPercent);
}

export const usageBand = (percent: number): UsageBand => (percent >= 90 ? 'high' : percent >= 70 ? 'mid' : 'low');

export function worstPercent(usage: ProviderUsage, nowMs: number): number {
  return usage.windows.reduce((worst, window) => Math.max(worst, effectivePercent(window, nowMs)), 0);
}

/** "2 h 13 min", "6 d 8 h", "12 min", "<1 min". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  return minutes > 0 ? `${minutes} min` : '<1 min';
}

/** Compact countdown for tight spots: "4h 2m", "5d 13h", "12m", "<1m". */
export function shortDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return minutes > 0 ? `${minutes}m` : '<1m';
}

/** Part of the e-mail before "@", cut to `max` characters; falls back to `fallback` when there is no e-mail. */
export function shortAccountName(email: string | undefined, fallback: string, max = 12): string {
  const local = email?.split('@')[0]?.trim();
  return local ? local.slice(0, max) : fallback;
}

/** Accounts that show numbers: not expired and either ok or carrying windows. */
export function summaryAccounts(providers: ProviderUsage[]): ProviderUsage[] {
  return providers.filter((u) => u.status !== 'signedOut' && u.status !== 'expired' && u.status !== 'apiKey' && (u.status === 'ok' || u.windows.length > 0));
}

/** "Claude 17% · Claude 40% · Codex 8%"; several Claude accounts are told apart by the e-mail name. Empty when nothing to show. */
export function usageSummary(providers: ProviderUsage[], nowMs: number): string {
  const shown = summaryAccounts(providers);
  const claudeCount = providers.filter((u) => u.provider === 'claude' && u.status !== 'signedOut').length;
  return shown.map((u) => {
    const base = u.provider === 'claude' ? 'Claude' : 'Codex';
    const name = u.provider === 'claude' && claudeCount > 1 ? shortAccountName(u.email, base) : base;
    return `${name} ${Math.round(worstPercent(u, nowMs))}%`;
  }).join(' · ');
}

/** What the usage panel offers for logging in to Claude on a platform (macOS cannot use isolated profiles: Keychain). */
export function claudeLoginActions(platform: string, hasMainClaude: boolean): {
  /** Entry in the "+" menu: sign in the main login (macOS) or add a managed account (elsewhere), or null. */
  menu: 'main' | 'new' | null;
  /** Login target of the empty-state Claude button. */
  emptyTarget: 'main' | 'new';
  /** Managed-account actions (make main, relogin of saved accounts) are available. */
  managedAccounts: boolean;
} {
  const mac = platform === 'darwin';
  return {
    menu: mac ? (hasMainClaude ? null : 'main') : 'new',
    emptyTarget: mac ? 'main' : 'new',
    managedAccounts: !mac,
  };
}

export type UsageErrorKind = 'rate' | 'server' | 'network' | 'parse' | 'empty' | 'refresh' | 'blocked' | 'other';

/** Groups the machine-readable reason of a failed read into what the card tells the user. */
export function usageErrorKind(code?: string): UsageErrorKind {
  if (!code) return 'other';
  if (code === 'http-429' || code === 'refresh-http-429') return 'rate';
  if (/^http-5\d\d$/.test(code)) return 'server';
  if (code === 'network' || code === 'timeout') return 'network';
  if (code === 'bad-response') return 'parse';
  if (code === 'no-windows') return 'empty';
  if (code === 'refresh-blocked') return 'blocked';
  if (code.startsWith('refresh-')) return 'refresh';
  return 'other';
}

/** HTTP status contained in a reason code (`http-429`, `refresh-http-503`), if any. */
export function usageHttpStatus(code?: string): number | undefined {
  const match = code ? /(?:^|-)http-(\d{3})$/.exec(code) : null;
  return match ? Number(match[1]) : undefined;
}

/** How a bug report names an account: its role, never its e-mail ("claude main", "claude saved #2", "codex"). */
export function diagnosticLabel(usage: Pick<ProviderUsage, 'provider' | 'managed'>, savedIndex = 1): string {
  if (usage.provider === 'codex') return 'codex';
  return usage.managed ? `claude saved #${Math.max(1, savedIndex)}` : 'claude main';
}

/** Short text for bug reports: reason, status and ages only. Never contains tokens or e-mails; `label` names the account (see `diagnosticLabel`). */
export function usageDiagnostics(usage: ProviderUsage, nowMs: number, label: string): string {
  const age = (at?: number) => (at === undefined ? 'n/a' : `${formatDuration((nowMs - at) / 1000)} ago`);
  const status = usageHttpStatus(usage.error);
  return [
    `account: ${label}`,
    `provider: ${usage.provider}${usage.managed ? ' (saved account)' : ''}${usage.plan ? `, plan ${usage.plan}` : ''}`,
    `state: ${usage.status}`,
    `reason: ${usage.error ?? 'none'}`,
    `http status: ${status ?? 'n/a'}`,
    `shared with main login: ${usage.shared ? 'yes' : 'no'}`,
    `data source: ${usage.source}, last good data ${age(usage.fetchedAt)}`,
    `last attempt: ${age(usage.attemptAt)}`,
    `next attempt: ${usage.retryAt === undefined ? 'n/a' : usage.retryAt <= nowMs ? 'due' : `in ${formatDuration((usage.retryAt - nowMs) / 1000)}`}`,
    `windows: ${usage.windows.length ? usage.windows.map((w) => `${w.id} ${Math.round(w.usedPercent)}%`).join(', ') : 'none'}`,
  ].join('\n');
}
