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
    fetch: fetchImpl, now: () => NOW, codexHome: () => join(home, '.codex'),
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
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SECRET}`, 'anthropic-beta': 'oauth-2025-04-20' });
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('does not use an expired token and says so', async () => {
    claudeLogin({ expiresAt: NOW - 1000 });
    const fetchSpy = vi.fn();
    expect((await fetchClaude(deps(fetchSpy))).usage).toMatchObject({ status: 'expired', plan: 'Max 5x' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps rejected tokens, rate limiting and bad bodies', async () => {
    claudeLogin();
    expect((await fetchClaude(deps((async () => reply(401, {})) as never))).usage.status).toBe('expired');
    expect((await fetchClaude(deps((async () => reply(403, {})) as never))).usage.status).toBe('expired');
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
    for (const failing of [async () => { throw new Error('offline'); }, async () => reply(401, {}), async () => reply(500, {}), async () => reply(200, { nothing: 1 })]) {
      const { usage } = await fetchCodex(deps(failing as never));
      expect(usage).toMatchObject({ status: 'ok', source: 'log', email: 'me@example.com' });
      expect(usage.windows[0].usedPercent).toBe(31);
      expect(usage.fetchedAt).toBe(Date.parse('2026-10-09T10:00:00Z'));
    }
    codexLogin(Math.floor(NOW / 1000) - 10);
    const spy = vi.fn();
    expect((await fetchCodex(deps(spy))).usage).toMatchObject({ status: 'ok', source: 'log' });
    expect(spy).not.toHaveBeenCalled();
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
