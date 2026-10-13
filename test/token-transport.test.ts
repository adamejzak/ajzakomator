import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_CLIENT_ID, refreshClaudeProfile, refreshLimitKey } from '../src/main/accounts/refresh';
import { createRefreshLimits } from '../src/main/accounts/refreshLimits';
import { ConnectFailure, createTokenFetch, directFetch, isConnectFailure } from '../src/main/accounts/tokenTransport';

interface Seen { method?: string; url?: string; rawHeaders: string[]; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server;
let seen: Seen[];
let answer: (res: http.ServerResponse, request: Seen) => void;
let base: string;
let dir: string;

beforeEach(async () => {
  seen = [];
  answer = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
  dir = mkdtempSync(join(tmpdir(), 'ajza-transport-'));
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { const request = { method: req.method, url: req.url, rawHeaders: req.rawHeaders, headers: req.headers, body }; seen.push(request); answer(res, request); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe('directFetch', () => {
  it('puts exactly the given headers on the wire: no browser fingerprint, no Claude Code User-Agent', async () => {
    const response = await directFetch(`${base}/v1/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ajzakomator/0.6.8' }, body: JSON.stringify({ grant_type: 'refresh_token' }),
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/v1/oauth/token');
    expect(Object.keys(seen[0].headers).sort()).toEqual(['connection', 'content-length', 'content-type', 'host', 'user-agent']);
    expect(seen[0].headers['user-agent']).toBe('ajzakomator/0.6.8');
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(seen[0].body).toBe('{"grant_type":"refresh_token"}');
  });

  it('returns status, headers and body of any answer, including 429 with Retry-After', async () => {
    answer = (res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '90' }); res.end('{"error":"rate_limit_error"}'); };
    const response = await directFetch(`${base}/x`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(429);
    expect(response.ok).toBe(false);
    expect(response.headers.get('retry-after')).toBe('90');
    expect(await response.json()).toEqual({ error: 'rate_limit_error' });
  });

  it('refuses redirects when asked to', async () => {
    answer = (res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/steal' }); res.end(); };
    await expect(directFetch(`${base}/x`, { method: 'POST', body: '{}', redirect: 'error' })).rejects.toThrow('redirect');
    expect(seen).toHaveLength(1);
  });

  it('aborts on a signal without calling it a connection failure', async () => {
    answer = () => { /* never answers */ };
    const controller = new AbortController();
    const pending = directFetch(`${base}/x`, { method: 'POST', body: '{}', signal: controller.signal });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(isConnectFailure(error)).toBe(false);
    expect((error as Error).name).toBe('AbortError');
  });

  it('reports a refused connection as a connect failure and a drop after connecting as a plain error', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(isConnectFailure(await directFetch(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}' }).catch((e: unknown) => e))).toBe(true);
    answer = (res) => { res.socket?.destroy(); };
    expect(isConnectFailure(await directFetch(`${base}/x`, { method: 'POST', body: '{}' }).catch((e: unknown) => e))).toBe(false);
  });
});

describe('createTokenFetch', () => {
  it('falls back (system proxy path) only when nothing could be sent, never after the server was reached', async () => {
    const fallback = vi.fn(async () => new Response('{}', { status: 200 }));
    const unreachable = vi.fn(async () => { throw new ConnectFailure('ECONNREFUSED'); });
    expect((await createTokenFetch(fallback as never, unreachable as never)('https://x.test/', { method: 'POST' })).status).toBe(200);
    expect(fallback).toHaveBeenCalledTimes(1);
    const dropped = vi.fn(async () => { throw new Error('reset after sending'); });
    await expect(createTokenFetch(fallback as never, dropped as never)('https://x.test/', { method: 'POST' })).rejects.toThrow('reset');
    const aborted = new AbortController();
    aborted.abort();
    await expect(createTokenFetch(fallback as never, unreachable as never)('https://x.test/', { method: 'POST', signal: aborted.signal })).rejects.toBeInstanceOf(ConnectFailure);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('token refresh against a mock token server', () => {
  const NOW = Date.parse('2026-10-13T12:00:00Z');
  const write = () => writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1, scopes: ['user:inference'] } }));
  const refresh = (limits = createRefreshLimits(undefined, () => NOW)) => refreshClaudeProfile(dir, {
    fetch: directFetch as never, now: () => NOW, tokenUrl: `${base}/v1/oauth/token`, userAgent: 'ajzakomator/0.6.8', limits, random: () => 0,
  });

  it('sends one JSON POST with the three fields and the product User-Agent, and stores the rotated tokens', async () => {
    write();
    answer = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800 })); };
    expect(await refresh()).toEqual({ kind: 'ok' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/oauth/token' });
    expect(Object.keys(seen[0].headers).sort()).toEqual(['connection', 'content-length', 'content-type', 'host', 'user-agent']);
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(seen[0].headers['user-agent']).toBe('ajzakomator/0.6.8');
    expect(JSON.parse(seen[0].body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: OAUTH_CLIENT_ID });
    expect(JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')).claudeAiOauth).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: NOW + 28_800_000 });
  });

  it('behaves like the live limiter: a claude-code User-Agent is answered with 429, ours is not, and a 429 is asked about only once', async () => {
    write();
    answer = (res, request) => {
      if (/^(claude-code|Mozilla)/.test(String(request.headers['user-agent']))) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }); res.end('{"error":{"type":"rate_limit_error"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'ok-access', expires_in: 60 }));
    };
    const limits = createRefreshLimits(join(dir, 'refresh-limits.json'), () => NOW);
    const viaOldAgent = await refreshClaudeProfile(dir, { fetch: directFetch as never, now: () => NOW, tokenUrl: `${base}/t`, userAgent: 'claude-code/2.1.34', limits, random: () => 0 });
    expect(viaOldAgent).toEqual({ kind: 'transient', detail: { reason: 'http-429', retryAfterMs: 300_000 } });
    // Five more calls inside the window (poll, manual, swap) do not reach the server.
    for (let i = 0; i < 5; i++) await refresh(limits);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'refresh-limits.json'), 'utf8'))).toHaveProperty(refreshLimitKey('old-refresh'));
  });

  it('works with the real default product User-Agent when nothing else is configured', async () => {
    write();
    answer = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'n', expires_in: 60 })); };
    expect(await refreshClaudeProfile(dir, { fetch: directFetch as never, now: () => NOW, tokenUrl: `${base}/t` })).toEqual({ kind: 'ok' });
    expect(seen[0].headers['user-agent']).toBe('ajzakomator');
  });
});
