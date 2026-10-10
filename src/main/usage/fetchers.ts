import type { ProviderUsage } from '../../shared/usage';
import { readCodexLog } from './codexLog';
import { readClaudeCredentials, readCodexCredentials, type CredentialSource } from './credentials';
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

export async function fetchClaude(deps: FetcherDeps): Promise<FetchResult> {
  const now = deps.now();
  const base: ProviderUsage = { provider: 'claude', status: 'signedOut', windows: [], fetchedAt: now, source: 'live' };
  const credentials = await readClaudeCredentials(deps.credentials);
  if (!credentials) return { usage: base };
  const known: ProviderUsage = { ...base, plan: credentials.plan };
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= now + EXPIRY_MARGIN_MS) return { usage: { ...known, status: 'expired' } };
  try {
    const response = await deps.fetch(deps.claudeUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credentials.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.34',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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
  const base: ProviderUsage = { provider: 'codex', status: 'signedOut', windows: [], fetchedAt: now, source: 'live' };
  const credentials = await readCodexCredentials(deps.credentials);
  if (!credentials) return { usage: base };
  if (credentials.mode === 'apiKey') return { usage: { ...base, status: 'apiKey' } };
  const known: ProviderUsage = { ...base, plan: credentials.plan, email: credentials.email };

  /** Network-free answer from the last Codex session; the real failure is reported when there is none. */
  const fromLog = async (status: 'expired' | 'error', error?: string, retry?: number): Promise<FetchResult> => {
    const log = await readCodexLog(deps.codexHome());
    if (log) {
      const usage: ProviderUsage = { ...known, plan: log.plan ?? known.plan, status: 'ok', windows: log.windows, fetchedAt: log.at, source: 'log' };
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
