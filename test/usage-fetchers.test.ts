// test/usage-fetchers.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCodexLog } from '../src/main/usage/codexLog';
import { fetchClaude, fetchCodex, type FetcherDeps } from '../src/main/usage/fetchers';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const SECRET = 'sk-ant-oat01-SECRET-TOKEN';
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: unknown) => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ajza-fetch-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const put = (rel: string, body: string) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), body); };

function deps(fetchImpl: FetcherDeps['fetch']): FetcherDeps {
  return {
    credentials: { env: {}, home, platform: 'win32', keychain: async () => null, readFile: (path) => readFile(path, 'utf8').catch(() => null) },
    fetch: fetchImpl, now: () => NOW, sleep: async () => undefined, codexHome: () => join(home, '.codex'),
    claudeUrl: 'https://claude.test/usage', codexUrl: 'https://codex.test/usage',
  };
}
const claudeLogin = (extra: Record<string, unknown> = {}) => put('.claude/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: NOW + 3_600_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x', ...extra } }));
const codexLogin = (exp = Math.floor(NOW / 1000) + 3600) => put('.codex/auth.json', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt({ exp }), id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }), account_id: 'acc-1' } }));
const claudeBody = { five_hour: { utilization: 42, resets_at: '2026-10-11T15:00:00Z' }, seven_day: { utilization: 7, resets_at: '2026-10-17T04:00:00Z' } };
const logEvent = (primary: number, ts: string) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: primary, window_minutes: 300, resets_at: 1781010642 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1781558816 }, plan_type: 'plus' } } });

describe('fetchClaude', () => {
  it('is signed out without credentials', async () => {
    const fetchSpy = vi.fn();
    expect((await fetchClaude(deps(fetchSpy))).usage).toMatchObject({ provider: 'claude', status: 'signedOut', windows: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads the windows and plan, sending only the documented headers', async () => {
    claudeLogin();
    const fetchSpy = vi.fn(async () => reply(200, claudeBody));
    const { usage } = await fetchClaude(deps(fetchSpy as never));
    expect(usage).toMatchObject({ provider: 'claude', status: 'ok', plan: 'Max 5x', source: 'live', fetchedAt: NOW });
    expect(usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([['5h', 42], ['7d', 7]]);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://claude.test/usage');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'unimux' });
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('sends its own User-Agent, never claude-code/ (investigation test 9)', async () => {
    claudeLogin();
    const fetchSpy = vi.fn(async () => reply(200, claudeBody));
    await fetchClaude({ ...deps(fetchSpy as never), userAgent: 'unimux/0.9.1' });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('unimux/0.9.1');
  });

  it('maps a 403 of the usage endpoint to forbidden, for the live login and saved accounts, without renewing (investigation test 6)', async () => {
    claudeLogin();
    expect((await fetchClaude(deps((async () => reply(403, {})) as never))).usage).toMatchObject({ status: 'forbidden', error: 'http-403' });
  });

  it('does not use an expired token and says so', async () => {
    claudeLogin({ expiresAt: NOW - 1000 });
    const fetchSpy = vi.fn();
    expect((await fetchClaude(deps(fetchSpy))).usage).toMatchObject({ status: 'expired', plan: 'Max 5x' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an expired main token with a refresh token as dormant: no request, no refresh', async () => {
    claudeLogin({ expiresAt: NOW - 1000, refreshToken: 'rt-secret' });
    const fetchSpy = vi.fn();
    const refreshClaude = vi.fn();
    const { usage } = await fetchClaude({ ...deps(fetchSpy), refreshClaude }); // main ref: never renewed by the app
    expect(usage).toMatchObject({ status: 'dormant', plan: 'Max 5x', windows: [] });
    expect(JSON.stringify(usage)).not.toContain('rt-secret');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(refreshClaude).not.toHaveBeenCalled();
  });

  it('re-reads once before calling an expired main token without refresh token expired', async () => {
    claudeLogin({ expiresAt: NOW - 1000 });
    let reads = 0;
    const d = deps(vi.fn() as never);
    const inner = d.credentials.readFile;
    d.credentials = { ...d.credentials, readFile: async (path) => { if (path.endsWith('.credentials.json') && ++reads === 2) claudeLogin(); return inner(path); } };
    const fetchSpy = vi.fn(async () => reply(200, claudeBody));
    // the atomic rewrite finished during the pause: the fresh token is used
    expect((await fetchClaude({ ...d, fetch: fetchSpy as never })).usage.status).toBe('ok');
  });

  it('re-reads a missing main credentials file once before reporting signed out', async () => {
    let reads = 0;
    const d = deps((async () => reply(200, claudeBody)) as never);
    const inner = d.credentials.readFile;
    d.credentials = { ...d.credentials, readFile: async (path) => { if (path.endsWith('.credentials.json') && ++reads === 2) claudeLogin(); return inner(path); } };
    expect((await fetchClaude(d)).usage.status).toBe('ok');
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('re-reads after a 401 on the main login and only then reports expired', async () => {
    claudeLogin({ refreshToken: 'rt' });
    const fetchSpy = vi.fn(async () => reply(401, {}));
    expect((await fetchClaude(deps(fetchSpy as never))).usage.status).toBe('expired');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Claude Code renewed the token meanwhile: the second request succeeds
    let calls = 0;
    expect((await fetchClaude(deps((async () => (++calls === 1 ? reply(401, {}) : reply(200, claudeBody))) as never))).usage.status).toBe('ok');
    // the re-read shows an expired token that can be renewed: dormant, not expired
    const d = deps((async () => { claudeLogin({ expiresAt: NOW - 5000, refreshToken: 'rt' }); return reply(401, {}); }) as never);
    expect((await fetchClaude(d)).usage.status).toBe('dormant');
  });

  it('maps rejected tokens, rate limiting and bad bodies', async () => {
    claudeLogin();
    expect((await fetchClaude(deps((async () => reply(401, {})) as never))).usage.status).toBe('expired');
    expect((await fetchClaude(deps((async () => reply(403, {})) as never))).usage.status).toBe('forbidden');
    const limited = await fetchClaude(deps((async () => reply(429, {}, { 'retry-after': '120' })) as never));
    expect(limited.usage).toMatchObject({ status: 'error', error: 'http-429' });
    expect(limited.retryAfterMs).toBe(120_000);
    expect((await fetchClaude(deps((async () => reply(500, {})) as never))).usage.error).toBe('http-500');
    expect((await fetchClaude(deps((async () => reply(200, { nothing: true })) as never))).usage.error).toBe('bad-response');
    expect((await fetchClaude(deps((async () => new Response('<html>', { status: 200 })) as never))).usage.error).toBe('bad-response');
  });

  it('classifies network failures and never leaks the token', async () => {
    claudeLogin();
    const leaky = await fetchClaude(deps((async () => { throw new Error(`connect failed for Bearer ${SECRET}`); }) as never));
    expect(leaky.usage).toMatchObject({ status: 'error', error: 'network' });
    expect(JSON.stringify(leaky)).not.toContain(SECRET);
    const timeout = await fetchClaude(deps((async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as never));
    expect(timeout.usage.error).toBe('timeout');
  });
});

describe('readCodexLog', () => {
  it('returns the newest event that has limits and ignores empty ones', async () => {
    put('.codex/sessions/2026/10/08/rollout-2026-10-08T10-00-00-a.jsonl', `${logEvent(11, '2026-10-08T10:00:00Z')}\n`);
    put('.codex/sessions/2026/10/09/rollout-2026-10-09T10-00-00-b.jsonl', `${logEvent(22, '2026-10-09T10:00:00Z')}\n${JSON.stringify({ timestamp: '2026-10-09T11:00:00Z', payload: { type: 'token_count', rate_limits: { primary: null, secondary: null } } })}\n`);
    const log = await readCodexLog(join(home, '.codex'));
    expect(log?.windows.map((w) => w.usedPercent)).toEqual([22, 3]);
    expect(log?.plan).toBe('plus');
    expect(log?.at).toBe(Date.parse('2026-10-09T10:00:00Z'));
  });

  it('reads only the tail of a huge log', async () => {
    const filler = `${'x'.repeat(2000)}\n`.repeat(2500);
    put('.codex/sessions/2026/10/10/rollout-2026-10-10T10-00-00-c.jsonl', `${filler}${logEvent(77, '2026-10-10T10:00:00Z')}\n`);
    expect((await readCodexLog(join(home, '.codex')))?.windows[0].usedPercent).toBe(77);
  });

  it('does not find an event that sits only in the unread head of a huge log', async () => {
    const filler = `${'x'.repeat(2000)}
`.repeat(2500);
    put('.codex/sessions/2026/10/10/rollout-2026-10-10T10-00-00-d.jsonl', `${logEvent(66, '2026-10-10T10:00:00Z')}
${filler}`);
    expect(await readCodexLog(join(home, '.codex'))).toBeNull();
  });

  it('is null without sessions or without any limits', async () => {
    expect(await readCodexLog(join(home, '.codex'))).toBeNull();
    put('.codex/sessions/2026/10/10/rollout-x.jsonl', 'not json\n{"payload":{}}\n');
    expect(await readCodexLog(join(home, '.codex'))).toBeNull();
  });
});

describe('fetchCodex', () => {
  const liveBody = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 18000, reset_at: 1781010642 }, secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 1781558816 } } };

  it('is signed out without credentials and has no limits for API key logins', async () => {
    expect((await fetchCodex(deps(vi.fn()))).usage.status).toBe('signedOut');
    put('.codex/auth.json', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: null }));
    expect((await fetchCodex(deps(vi.fn()))).usage).toMatchObject({ status: 'apiKey', windows: [] });
  });

  it('reads the live limits with the account header and labels the account', async () => {
    codexLogin();
    const fetchSpy = vi.fn(async () => reply(200, liveBody));
    const { usage } = await fetchCodex(deps(fetchSpy as never));
    expect(usage).toMatchObject({ provider: 'codex', status: 'ok', source: 'live', plan: 'plus', email: 'me@example.com' });
    expect(usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([['5h', 9], ['7d', 4]]);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'ChatGPT-Account-Id': 'acc-1' });
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it('falls back to the last session when the live request fails, is rejected or the token expired', async () => {
    codexLogin();
    put('.codex/sessions/2026/10/09/rollout-a.jsonl', `${logEvent(31, '2026-10-09T10:00:00Z')}\n`);
    for (const failing of [async () => { throw new Error('offline'); }, async () => reply(401, {}), async () => reply(403, {}), async () => reply(500, {}), async () => reply(200, { nothing: 1 })]) {
      const { usage } = await fetchCodex(deps(failing as never));
      const dead = [401, 403].includes((await failing().then((r) => (r as Response).status, () => 0)));
      expect(usage).toMatchObject({ status: dead ? 'expired' : 'ok', source: 'log', email: 'me@example.com' });
      expect(usage.windows[0].usedPercent).toBe(31);
      expect(usage.fetchedAt).toBe(Date.parse('2026-10-09T10:00:00Z'));
    }
    codexLogin(Math.floor(NOW / 1000) - 10);
    const spy = vi.fn();
    expect((await fetchCodex(deps(spy))).usage).toMatchObject({ status: 'expired', source: 'log' });
    expect((await fetchCodex(deps(spy))).usage.windows[0].usedPercent).toBe(31);
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks a log answer as failed after a rejected request but not when no request was made', async () => {
    codexLogin();
    put('.codex/sessions/2026/10/09/rollout-a.jsonl', `${logEvent(31, '2026-10-09T10:00:00Z')}
`);
    const limited = await fetchCodex(deps((async () => reply(429, {}, { 'retry-after': '90' })) as never));
    expect(limited.usage).toMatchObject({ status: 'ok', source: 'log' });
    expect(limited.failed).toBe(true);
    expect(limited.retryAfterMs).toBe(90_000);
    expect((await fetchCodex(deps((async () => { throw new Error('offline'); }) as never))).failed).toBe(true);
    expect((await fetchCodex(deps((async () => reply(401, {})) as never))).failed).toBeUndefined();
    codexLogin(Math.floor(NOW / 1000) - 10);
    expect((await fetchCodex(deps(vi.fn()))).failed).toBeUndefined();
  });

  it('reports the real failure when there is no session log to fall back on', async () => {
    codexLogin();
    expect((await fetchCodex(deps((async () => reply(401, {})) as never))).usage).toMatchObject({ status: 'expired', windows: [] });
    const limited = await fetchCodex(deps((async () => reply(429, {}, { 'retry-after': '30' })) as never));
    expect(limited.usage).toMatchObject({ status: 'error', error: 'http-429' });
    expect(limited.retryAfterMs).toBe(30_000);
    const leak = await fetchCodex(deps((async () => { throw new Error('boom Bearer abc.def.ghi'); }) as never));
    expect(JSON.stringify(leak)).not.toContain('abc.def.ghi');
  });
});

describe('account identity', () => {
  it('tags the main Claude account and reads its identity from .claude.json', async () => {
    claudeLogin();
    put('.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Acme' } }));
    const { usage } = await fetchClaude(deps((async () => reply(200, claudeBody)) as never));
    expect(usage).toMatchObject({ accountId: 'claude:main', provider: 'claude', status: 'ok', email: 'me@example.com', org: 'Acme' });
    expect(usage.managed).toBeUndefined();
  });

  it('reads credentials and identity of a managed profile only', async () => {
    claudeLogin();
    put('.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'main@example.com' } }));
    put('profiles/abc/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'tok-profile', expiresAt: NOW + 3_600_000 } }));
    put('profiles/abc/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com', organizationName: 'Work' } }));
    const fetchSpy = vi.fn(async () => reply(200, claudeBody));
    const { usage } = await fetchClaude(deps(fetchSpy as never), { id: 'claude:abc', provider: 'claude', configDir: join(home, 'profiles', 'abc') });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-profile' });
    expect(JSON.stringify(init.headers)).not.toContain(SECRET);
    expect(usage).toMatchObject({ accountId: 'claude:abc', status: 'ok', email: 'work@example.com', org: 'Work', managed: true });
  });

  it('does not fall back to the main login for a signed-out profile', async () => {
    claudeLogin();
    const fetchSpy = vi.fn();
    const { usage } = await fetchClaude(deps(fetchSpy), { id: 'claude:abc', provider: 'claude', configDir: join(home, 'profiles', 'abc') });
    expect(usage).toMatchObject({ accountId: 'claude:abc', status: 'signedOut', managed: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tags the Codex account', async () => {
    expect((await fetchCodex(deps(vi.fn()))).usage.accountId).toBe('codex:main');
  });
});

describe('managed token renewal', () => {
  const ref = () => ({ id: 'claude:abc', provider: 'claude' as const, configDir: join(home, 'profiles', 'abc') });
  const profileLogin = (token: string, expiresAt: number) => put('profiles/abc/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } }));
  const withRefresh = (fetchImpl: FetcherDeps['fetch'], refreshClaude: FetcherDeps['refreshClaude']): FetcherDeps => ({ ...deps(fetchImpl), refreshClaude });

  it('renews an expired token first and requests the usage with the new one', async () => {
    profileLogin('old-tok', NOW - 1000);
    const refresh = vi.fn(async (dir: string) => { put('profiles/abc/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'new-tok', expiresAt: NOW + 3_600_000 } })); return { kind: 'ok' as const }; });
    const fetchSpy = vi.fn(async () => reply(200, claudeBody));
    const { usage } = await fetchClaude(withRefresh(fetchSpy as never, refresh), ref());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(ref().configDir);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer new-tok' });
    expect(usage.status).toBe('ok');
  });

  it('reports expired for a dead login and error for a transient failure without requesting usage', async () => {
    profileLogin('old-tok', NOW - 1000);
    const fetchSpy = vi.fn();
    expect((await fetchClaude(withRefresh(fetchSpy, async () => ({ kind: 'dead' })), ref())).usage.status).toBe('expired');
    const transient = await fetchClaude(withRefresh(fetchSpy, async () => ({ kind: 'transient', detail: { reason: 'network' } })), ref());
    expect(transient.usage).toMatchObject({ status: 'error', error: 'refresh-network' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renews once and retries once after a 401', async () => {
    profileLogin('old-tok', NOW + 3_600_000);
    const refresh = vi.fn(async () => { put('profiles/abc/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'new-tok', expiresAt: NOW + 3_600_000 } })); return { kind: 'ok' as const }; });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(reply(401, {}))
      .mockResolvedValueOnce(reply(200, claudeBody));
    expect((await fetchClaude(withRefresh(fetchSpy as never, refresh), ref())).usage.status).toBe('ok');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((fetchSpy.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer new-tok' });
  });

  it('does not renew after a 403', async () => {
    profileLogin('old-tok', NOW + 3_600_000);
    const refresh = vi.fn(async () => ({ kind: 'ok' as const }));
    const fetchSpy = vi.fn(async () => reply(403, {}));
    expect((await fetchClaude(withRefresh(fetchSpy as never, refresh), ref())).usage.status).toBe('forbidden');
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives expired after a second 401', async () => {
    profileLogin('old-tok', NOW + 3_600_000);
    const refresh = vi.fn(async () => ({ kind: 'ok' as const }));
    const fetchSpy = vi.fn(async () => reply(401, {}));
    expect((await fetchClaude(withRefresh(fetchSpy as never, refresh), ref())).usage.status).toBe('expired');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('never renews the main account', async () => {
    claudeLogin({ expiresAt: NOW - 1000 });
    const refresh = vi.fn();
    const fetchSpy = vi.fn();
    expect((await fetchClaude(withRefresh(fetchSpy, refresh))).usage.status).toBe('expired');
    claudeLogin();
    expect((await fetchClaude(withRefresh((async () => reply(401, {})) as never, refresh))).usage.status).toBe('expired');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('why a saved account fails to read', () => {
  const ref = () => ({ id: 'claude:abc', provider: 'claude' as const, configDir: join(home, 'profiles', 'abc') });
  const profileLogin = (extra: Record<string, unknown> = {}) => put('profiles/abc/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'prof-tok', refreshToken: 'prof-refresh', expiresAt: NOW + 3_600_000, ...extra } }));
  const withRefresh = (fetchImpl: FetcherDeps['fetch'], refreshClaude: FetcherDeps['refreshClaude']): FetcherDeps => ({ ...deps(fetchImpl), refreshClaude });

  it('reads an account whose weekly limit is exhausted (100 percent, null resets, extra fields) as ok', async () => {
    profileLogin();
    const body = { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 100, resets_at: '2026-10-15T21:59:59+00:00' }, seven_day_opus: null, extra_usage: { is_enabled: false, utilization: null } };
    const { usage } = await fetchClaude(withRefresh((async () => reply(200, body)) as never, undefined), ref());
    expect(usage).toMatchObject({ status: 'ok', managed: true });
    expect(usage.windows.map((w) => [w.id, w.usedPercent])).toEqual([['5h', 0], ['7d', 100]]);
    expect(usage.error).toBeUndefined();
  });

  it('keeps the HTTP status, honours Retry-After (also as a date) and tells an empty answer apart from a broken one', async () => {
    profileLogin();
    const limited = await fetchClaude(withRefresh((async () => reply(429, {}, { 'retry-after': '300' })) as never, undefined), ref());
    expect(limited.usage).toMatchObject({ status: 'error', error: 'http-429' });
    expect(limited.retryAfterMs).toBe(300_000);
    const dated = await fetchClaude(withRefresh((async () => reply(429, {}, { 'retry-after': new Date(NOW + 45_000).toUTCString() })) as never, undefined), ref());
    expect(dated.retryAfterMs).toBe(45_000);
    expect((await fetchClaude(withRefresh((async () => reply(503, {})) as never, undefined), ref())).usage.error).toBe('http-503');
    expect((await fetchClaude(withRefresh((async () => reply(200, { five_hour: null, seven_day: null })) as never, undefined), ref())).usage).toMatchObject({ status: 'error', error: 'no-windows' });
    expect((await fetchClaude(withRefresh((async () => reply(200, { nothing: 1 })) as never, undefined), ref())).usage.error).toBe('bad-response');
  });

  it('names the refresh failure and passes on the token endpoint Retry-After', async () => {
    profileLogin({ expiresAt: NOW - 1000 });
    const fetchSpy = vi.fn();
    const limited = await fetchClaude(withRefresh(fetchSpy, async () => ({ kind: 'transient', detail: { reason: 'http-429', retryAfterMs: 600_000 } })), ref());
    expect(limited.usage).toMatchObject({ status: 'error', error: 'refresh-http-429' });
    expect(limited.retryAfterMs).toBe(600_000);
    expect((await fetchClaude(withRefresh(fetchSpy, async () => ({ kind: 'transient', detail: { reason: 'blocked' } })), ref())).usage.error).toBe('refresh-blocked');
    expect((await fetchClaude(withRefresh(fetchSpy, async () => ({ kind: 'dead' })), ref())).usage).toMatchObject({ status: 'expired', error: 'refresh-dead' });
    expect((await fetchClaude(withRefresh(fetchSpy, async () => ({ kind: 'unusable' })), ref())).usage).toMatchObject({ status: 'expired', error: 'refresh-unusable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a rejected token after the renewal as expired with the status', async () => {
    profileLogin();
    const refresh = vi.fn(async () => ({ kind: 'ok' as const }));
    expect((await fetchClaude(withRefresh((async () => reply(403, {})) as never, refresh), ref())).usage).toMatchObject({ status: 'forbidden', error: 'http-403' });
  });

  describe('a saved account whose family lives elsewhere (R6)', () => {
    const held = (renew: 'held-by-live' | 'held-by-cswap' | 'switched-out') => ({ ...ref(), renew });

    it('is never renewed: no token request, status elsewhere when its token ran out (investigation test 5)', async () => {
      profileLogin({ expiresAt: NOW - 1000 });
      const refresh = vi.fn();
      const fetchSpy = vi.fn();
      for (const renew of ['held-by-live', 'held-by-cswap', 'switched-out'] as const) {
        const { usage } = await fetchClaude(withRefresh(fetchSpy, refresh), held(renew));
        expect(usage).toMatchObject({ status: 'elsewhere', managed: true, heldBy: renew === 'held-by-live' ? 'live' : renew === 'held-by-cswap' ? 'cswap' : 'switched-out' });
      }
      expect(refresh).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still reads its limits with a valid access token and turns a 401 into elsewhere without renewing', async () => {
      profileLogin();
      const refresh = vi.fn();
      expect((await fetchClaude(withRefresh((async () => reply(200, claudeBody)) as never, refresh), held('held-by-cswap'))).usage.status).toBe('ok');
      expect((await fetchClaude(withRefresh((async () => reply(401, {})) as never, refresh), held('held-by-cswap'))).usage.status).toBe('elsewhere');
      expect(refresh).not.toHaveBeenCalled();
    });

    it('marks the live card as active', async () => {
      claudeLogin();
      const { usage } = await fetchClaude(deps((async () => reply(200, claudeBody)) as never), { id: 'claude:main', provider: 'claude', active: true });
      expect(usage.active).toBe(true);
    });
  });
});
