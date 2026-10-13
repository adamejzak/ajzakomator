import { MAIN_ACCOUNTS, type AccountRef, type ProviderUsage } from '../../shared/usage';
import type { RefreshOutcome } from '../accounts/refresh';
import { readCodexLog } from './codexLog';
import { profileSource, readClaudeCredentials, readClaudeIdentity, readCodexCredentials, type ClaudeCredentials, type CredentialSource } from './credentials';
import { parseClaudeUsage, parseCodexPlan, parseCodexRateLimits } from './parse';
import { parseRetryAfter } from './retryAfter';

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
  /** Pause used before re-reading the main login's file (Claude Code rewrites it atomically); tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

/** How long to wait before the one re-read of a main login that looks missing, expired or rejected. */
const REREAD_DELAY_MS = 300;

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

const retryAfterMs = (response: Response, nowMs: number): number | undefined => parseRetryAfter(response.headers.get('retry-after'), nowMs);

/** The main login's read of the current poll, so a saved account holding the same login reuses it instead of asking again. */
const mainReads = new WeakMap<FetcherDeps, { at: number; read: Promise<FetchResult> }>();
const MAIN_READ_REUSE_MS = 20_000;

export function fetchClaude(deps: FetcherDeps, ref: AccountRef = MAIN_ACCOUNTS[0]): Promise<FetchResult> {
  if (ref.configDir) return readClaude(deps, ref);
  const read = readClaude(deps, ref);
  mainReads.set(deps, { at: deps.now(), read });
  return read;
}

async function readClaude(deps: FetcherDeps, ref: AccountRef): Promise<FetchResult> {
  const now = deps.now();
  const managedSource = ref.configDir ? profileSource(deps.credentials, ref.configDir) : deps.credentials;
  let source = managedSource;
  const base: ProviderUsage = { accountId: ref.id, provider: 'claude', status: 'signedOut', windows: [], fetchedAt: now, source: 'live', ...(ref.configDir ? { managed: true } : {}) };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // The main login belongs to Claude Code, which rewrites the file while renewing; one re-read avoids reporting that moment.
  const reread = async (): Promise<ClaudeCredentials | null> => { await sleep(REREAD_DELAY_MS); return readClaudeCredentials(source); };
  let credentials: ClaudeCredentials | null = await readClaudeCredentials(source);
  if (!credentials && !ref.configDir) credentials = await reread();
  if (!credentials) return { usage: base };
  // A saved account holding the very refresh token of the main login (a swap by another tool wrote the same login to
  // both places) is read through the main login: renewing the saved copy would rotate the token under Claude Code.
  let shared = false;
  if (ref.configDir && credentials.refreshHash && deps.credentials.platform !== 'darwin') {
    const main = await readClaudeCredentials(deps.credentials);
    if (main?.refreshHash === credentials.refreshHash) { shared = true; credentials = main; source = deps.credentials; }
  }
  if (shared) {
    // The same login was just read for the main card in this poll: its answer is this account's answer too (one request, not two).
    const recent = mainReads.get(deps);
    if (recent && Math.abs(now - recent.at) <= MAIN_READ_REUSE_MS) {
      const main = await recent.read.catch(() => undefined);
      if (main) {
        const identity = await readClaudeIdentity(managedSource);
        return { ...main, usage: { ...main.usage, accountId: ref.id, managed: true, shared: true, email: identity.email, org: identity.org } };
      }
    }
  }
  const isMain = !ref.configDir || shared;
  const identity = await readClaudeIdentity(managedSource);
  const known: ProviderUsage = { ...base, plan: credentials.plan, email: identity.email, org: identity.org, ...(shared ? { shared: true } : {}) };
  // Only profiles owned by the app are renewed; the main login belongs to Claude Code.
  const refresh = isMain ? undefined : deps.refreshClaude;
  const configDir = ref.configDir ?? '';
  /** Renews the profile and re-reads its credentials; returns the failure result instead when that did not work. */
  const renew = async (): Promise<FetchResult | undefined> => {
    const outcome = await refresh!(configDir);
    if (outcome.kind === 'dead' || outcome.kind === 'unusable') return { usage: { ...known, status: 'expired', error: `refresh-${outcome.kind}` } };
    if (outcome.kind === 'transient') {
      const retry = outcome.detail?.retryAfterMs;
      return { usage: { ...known, status: 'error', error: `refresh-${outcome.detail?.reason ?? 'failed'}` }, ...(retry !== undefined ? { retryAfterMs: retry } : {}) };
    }
    const renewed = await readClaudeCredentials(source);
    if (!renewed) return { usage: { ...known, status: 'expired', error: 'refresh-reread' } };
    credentials = renewed;
    return undefined;
  };
  const expired = (): boolean => credentials!.expiresAt !== undefined && credentials!.expiresAt <= now + EXPIRY_MARGIN_MS;
  const dormant: FetchResult = { usage: { ...known, status: 'dormant' } };
  if (expired()) {
    if (!refresh) {
      // Main login: with a refresh token Claude Code renews the access token on its next use, which is not an error.
      if (credentials.hasRefresh) return dormant;
      const again = await reread();
      if (again) credentials = again;
      if (expired()) return { usage: { ...known, status: again?.hasRefresh ? 'dormant' : 'expired' } };
    } else {
      const failure = await renew();
      if (failure) return failure;
      if (expired()) return { usage: { ...known, status: 'expired', error: 'token-expired' } };
    }
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
    if (refresh && response.status === 401) {
      const failure = await renew();
      if (failure) return failure;
      response = await request();
    }
    if (isMain && (response.status === 401 || response.status === 403)) {
      // Claude Code may have just renewed the token: look at the file once more before calling the login dead.
      const again = await reread();
      if (again) {
        credentials = again;
        if (expired()) return { usage: { ...known, status: again.hasRefresh ? 'dormant' : 'expired' } };
        response = await request();
      }
    }
    if (response.status === 401 || response.status === 403) return { usage: { ...known, status: 'expired', error: `http-${response.status}` } };
    if (!response.ok) return { usage: { ...known, status: 'error', error: `http-${response.status}` }, retryAfterMs: retryAfterMs(response, now) };
    const windows = parseClaudeUsage(await response.json());
    if (!windows) return { usage: { ...known, status: 'error', error: 'bad-response' } };
    if (!windows.length) return { usage: { ...known, status: 'error', error: 'no-windows' } };
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
    if (!response.ok) return fromLog('error', `http-${response.status}`, retryAfterMs(response, now));
    const body: unknown = await response.json();
    const windows = parseCodexRateLimits(body, now);
    if (!windows) return fromLog('error', 'bad-response');
    return { usage: { ...known, plan: parseCodexPlan(body) ?? known.plan, status: 'ok', windows } };
  } catch (error) {
    return fromLog('error', errorKind(error));
  }
}
