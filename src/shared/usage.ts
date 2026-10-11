/** Limits of the user's Claude and Codex accounts: types and pure helpers shared by main process and window. */
export type UsageProvider = 'claude' | 'codex';
export type UsageStatus = 'ok' | 'signedOut' | 'expired' | 'apiKey' | 'error';
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
  /** Short machine-readable reason (for example `http-429`); never a token. */
  error?: string;
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
