import { MAIN_ACCOUNTS, type AccountRef, type ProviderUsage } from '../../shared/usage';
import type { RefreshOutcome } from '../accounts/refresh';
import { readCodexLog } from './codexLog';
import { profileSource, readClaudeCredentials, readClaudeIdentity, readCodexCredentials, type CredentialSource } from './credentials';
import { parseClaudeUsage, parseCodexPlan, parseCodexRateLimits } from './parse';

const REQUEST_TIMEOUT_MS = 5000;
/** A token that expires within this margin is treated as expired rather than risking a rejected request. */
const EXPIRY_MARGIN_MS = 30_000;

export interface FetcherDeps {
  credentials: CredentialSource;
  fetch: typeof fetch;
  now(): number;
  codexHome(): string;
  claudeUrl: string;
  codexUrl: string;
  /** Renews the tokens of a managed Claude profile directory; absent in tests that do not need it. */
  refreshClaude?: (dir: string) => Promise<RefreshOutcome>;
}

export interface FetchResult {
  usage: ProviderUsage;
  retryAfterMs?: number;
  /** The live request failed although another source answered; the service still backs off. */
  failed?: true;
}

/** Maps a thrown error to a short stable reason; the message itself may contain secrets and is dropped. */
function errorKind(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (error instanceof SyntaxError) return 'bad-response';
  return 'network';
}

const retryAfterMs = (response: Response): number | undefined => {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
};

export async function fetchClaude(deps: FetcherDeps, ref: AccountRef = MAIN_ACCOUNTS[0]): Promise<FetchResult> {
  const now = deps.now();
  const source = ref.configDir ? profileSource(deps.credentials, ref.configDir) : deps.credentials;
  const base: ProviderUsage = { accountId: ref.id, provider: 'claude', status: 'signedOut', windows: [], fetchedAt: now, source: 'live', ...(ref.configDir ? { managed: true } : {}) };
  let credentials = await readClaudeCredentials(source);
  if (!credentials) return { usage: base };
  const identity = await readClaudeIdentity(source);
  const known: ProviderUsage = { ...base, plan: credentials.plan, email: identity.email, org: identity.org };
  // Only profiles owned by the app are renewed; the main login belongs to Claude Code.
  const refresh = ref.configDir ? deps.refreshClaude : undefined;
  const configDir = ref.configDir ?? '';
  /** Renews the profile and re-reads its credentials; returns the failure result instead when that did not work. */
  const renew = async (): Promise<FetchResult | undefined> => {
    const outcome = await refresh!(configDir);
    if (outcome.kind === 'dead') return { usage: { ...known, status: 'expired' } };
    if (outcome.kind === 'transient') return { usage: { ...known, status: 'error', error: 'network' } };
    const renewed = await readClaudeCredentials(source);
    if (!renewed) return { usage: { ...known, status: 'expired' } };
    credentials = renewed;
    return undefined;
  };
  const expired = (): boolean => credentials!.expiresAt !== undefined && credentials!.expiresAt <= now + EXPIRY_MARGIN_MS;
  if (expired()) {
    if (!refresh) return { usage: { ...known, status: 'expired' } };
    const failure = await renew();
    if (failure) return failure;
    if (expired()) return { usage: { ...known, status: 'expired' } };
  }
  const request = () => deps.fetch(deps.claudeUrl, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${credentials!.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.34',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  try {
    let response = await request();
    if (refresh && (response.status === 401 || response.status === 403)) {
      const failure = await renew();
      if (failure) return failure;
      response = await request();
    }
    if (response.status === 401 || response.status === 403) return { usage: { ...known, status: 'expired' } };
    if (!response.ok) return { usage: { ...known, status: 'error', error: `http-${response.status}` }, retryAfterMs: retryAfterMs(response) };
    const windows = parseClaudeUsage(await response.json());
    if (!windows) return { usage: { ...known, status: 'error', error: 'bad-response' } };
    return { usage: { ...known, status: 'ok', windows } };
  } catch (error) {
    return { usage: { ...known, status: 'error', error: errorKind(error) } };
  }
}

export async function fetchCodex(deps: FetcherDeps): Promise<FetchResult> {
  const now = deps.now();
  const base: ProviderUsage = { accountId: 'codex:main', provider: 'codex', status: 'signedOut', windows: [], fetchedAt: now, source: 'live' };
  const credentials = await readCodexCredentials(deps.credentials);
  if (!credentials) return { usage: base };
  if (credentials.mode === 'apiKey') return { usage: { ...base, status: 'apiKey' } };
  const known: ProviderUsage = { ...base, plan: credentials.plan, email: credentials.email };

  /** Network-free answer from the last Codex session; the real failure is reported when there is none. */
  const fromLog = async (status: 'expired' | 'error', error?: string, retry?: number): Promise<FetchResult> => {
    const log = await readCodexLog(deps.codexHome());
    if (log) {
      // A dead login is reported even though the log has numbers; a failed request is not, the log is as fresh either way.
      const usage: ProviderUsage = { ...known, plan: log.plan ?? known.plan, status: error ? 'ok' : 'expired', windows: log.windows, fetchedAt: log.at, source: 'log' };
      return error ? { usage, failed: true, retryAfterMs: retry } : { usage };
    }
    return { usage: { ...known, status, ...(error ? { error } : {}) }, retryAfterMs: retry };
  };

  if (credentials.expiresAt !== undefined && credentials.expiresAt <= now + EXPIRY_MARGIN_MS) return fromLog('expired');
  try {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${credentials.accessToken}` };
    if (credentials.accountId) headers['ChatGPT-Account-Id'] = credentials.accountId;
    const response = await deps.fetch(deps.codexUrl, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 401 || response.status === 403) return fromLog('expired');
    if (!response.ok) return fromLog('error', `http-${response.status}`, retryAfterMs(response));
    const body: unknown = await response.json();
    const windows = parseCodexRateLimits(body, now);
    if (!windows) return fromLog('error', 'bad-response');
    return { usage: { ...known, plan: parseCodexPlan(body) ?? known.plan, status: 'ok', windows } };
  } catch (error) {
    return fromLog('error', errorKind(error));
  }
}
