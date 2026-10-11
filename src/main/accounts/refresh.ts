import { randomUUID } from 'crypto';
import { readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Public client id of Claude Code's OAuth flow (the same value claude-swap uses). */
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REQUEST_TIMEOUT_MS = 10_000;
const DEAD_ERRORS = /^(invalid_grant|invalid_client|unauthorized_client)$/;

export type RefreshOutcome = { kind: 'ok' } | { kind: 'dead' } | { kind: 'transient' };
export interface RefreshDeps { fetch: typeof fetch; now(): number; tokenUrl?: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const inflight = new Map<string, Promise<RefreshOutcome>>();

/**
 * Renews the tokens of an isolated profile owned by this app. Only such profiles are ever written: the machine's own
 * login belongs to Claude Code. Concurrent calls for one profile share one request, so the rotating refresh token
 * is used once.
 */
export function refreshClaudeProfile(dir: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const running = inflight.get(dir);
  if (running) return running;
  const promise = run(dir, deps).finally(() => { inflight.delete(dir); });
  inflight.set(dir, promise);
  return promise;
}

async function run(dir: string, deps: RefreshDeps): Promise<RefreshOutcome> {
  const file = join(dir, '.credentials.json');
  let data: unknown;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch { return { kind: 'transient' }; }
  const oauth = isRecord(data) && isRecord(data.claudeAiOauth) ? data.claudeAiOauth : undefined;
  if (!isRecord(data) || !oauth) return { kind: 'transient' };
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
  } catch { return { kind: 'transient' }; }
  if (!response.ok) {
    let error: unknown;
    try { error = ((await response.json()) as { error?: unknown }).error; } catch { /* no usable body */ }
    const code = typeof error === 'string' ? error : isRecord(error) && typeof error.type === 'string' ? error.type : '';
    return [400, 401, 403].includes(response.status) && DEAD_ERRORS.test(code) ? { kind: 'dead' } : { kind: 'transient' };
  }
  let body: unknown;
  try { body = await response.json(); } catch { return { kind: 'transient' }; }
  if (!isRecord(body) || typeof body.access_token !== 'string' || !body.access_token || typeof body.expires_in !== 'number') return { kind: 'transient' };
  oauth.accessToken = body.access_token;
  oauth.expiresAt = deps.now() + body.expires_in * 1000;
  if (typeof body.refresh_token === 'string' && body.refresh_token) oauth.refreshToken = body.refresh_token;
  if (typeof body.scope === 'string' && body.scope) oauth.scopes = body.scope.split(' ');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, file);
  } catch { return { kind: 'transient' }; }
  return { kind: 'ok' };
}
