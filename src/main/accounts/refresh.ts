import { randomUUID } from 'crypto';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { parseRetryAfter } from '../usage/retryAfter';

export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Public client id of Claude Code's OAuth flow (the same value claude-swap uses). */
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REQUEST_TIMEOUT_MS = 10_000;
const WRITE_TRIES = 3;
const DEAD_ERRORS = /^(invalid_grant|invalid_client|unauthorized_client)$/;

/** Why a renewal did not happen right now (no token inside): `read`, `network`, `bad-response`, `write`, `http-<status>` or `blocked`. */
export interface TransientDetail { reason: string; retryAfterMs?: number }
/** 'unusable': the server rotated the token but it could not be stored, so the saved login is lost (sign in again). */
export type RefreshOutcome = { kind: 'ok' } | { kind: 'dead' } | { kind: 'transient'; detail?: TransientDetail } | { kind: 'unusable' };
const transient = (reason: string, retryAfterMs?: number): RefreshOutcome => ({ kind: 'transient', detail: { reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } });
/** How long a refresh the server calls dead waits before the file is looked at once more (another process may have just renewed it). */
const DEAD_RECHECK_MS = 250;
export interface RefreshDeps { fetch: typeof fetch; now(): number; tokenUrl?: string; delay?(ms: number): Promise<void> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const inflight = new Map<string, Promise<RefreshOutcome>>();
const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier job on the same profile directory finished, so refreshes and swap writes never interleave. */
export function withProfileLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const tail = result.then(() => undefined, () => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return result;
}

/**
 * Renews the tokens of an isolated profile owned by this app. Only such profiles are ever written: the machine's own
 * login belongs to Claude Code. Concurrent calls for one profile share one request, so the rotating refresh token
 * is used once.
 */
export function refreshClaudeProfile(dir: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const key = resolve(dir);
  const running = inflight.get(key);
  if (running) return running;
  const promise = withProfileLock(dir, () => run(dir, deps)).finally(() => { inflight.delete(key); });
  inflight.set(key, promise);
  return promise;
}

async function run(dir: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const file = join(dir, '.credentials.json');
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let data: unknown;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch { return transient('read'); }
  const oauth = isRecord(data) && isRecord(data.claudeAiOauth) ? data.claudeAiOauth : undefined;
  if (!isRecord(data) || !oauth) return transient('read');
  if (typeof oauth.refreshToken !== 'string' || !oauth.refreshToken) return { kind: 'dead' };
  let response: Response;
  try {
    response = await deps.fetch(deps.tokenUrl ?? OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-code/2.1.34' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch { return transient('network'); }
  if (!response.ok) {
    let error: unknown;
    try { error = ((await response.json()) as { error?: unknown }).error; } catch { /* no usable body */ }
    const code = typeof error === 'string' ? error : isRecord(error) && typeof error.type === 'string' ? error.type : '';
    if ([400, 401, 403].includes(response.status) && DEAD_ERRORS.test(code)) {
      // Another process using this very profile (a Claude session) may have renewed it a moment ago: its newer token is not dead.
      await delay(DEAD_RECHECK_MS);
      try {
        const again: unknown = JSON.parse(await readFile(file, 'utf8'));
        const current = isRecord(again) && isRecord(again.claudeAiOauth) ? again.claudeAiOauth.refreshToken : undefined;
        if (typeof current === 'string' && current && current !== oauth.refreshToken) return { kind: 'ok' };
      } catch { /* the file is unreadable: the login counts as dead */ }
      return { kind: 'dead' };
    }
    return transient(`http-${response.status}`, parseRetryAfter(response.headers.get('retry-after'), deps.now()));
  }
  let body: unknown;
  try { body = await response.json(); } catch { return transient('bad-response'); }
  if (!isRecord(body) || typeof body.access_token !== 'string' || !body.access_token || typeof body.expires_in !== 'number') return transient('bad-response');
  oauth.accessToken = body.access_token;
  oauth.expiresAt = deps.now() + body.expires_in * 1000;
  if (typeof body.refresh_token === 'string' && body.refresh_token) oauth.refreshToken = body.refresh_token;
  if (typeof body.scope === 'string' && body.scope) oauth.scopes = body.scope.split(' ');
  const text = JSON.stringify(data);
  for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, file);
      return { kind: 'ok' };
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (attempt < WRITE_TRIES - 1) await delay(100);
    }
  }
  // A rotated refresh token was already used up on the server: a plain 'transient' would let callers go on with a dead token.
  return typeof body.refresh_token === 'string' && body.refresh_token ? { kind: 'unusable' } : transient('write');
}
