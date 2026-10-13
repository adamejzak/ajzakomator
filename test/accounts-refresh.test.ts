import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_CLIENT_ID, refreshClaudeProfile } from '../src/main/accounts/refresh';

const NOW = Date.parse('2026-10-11T12:00:00Z');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ajza-refresh-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (data: unknown) => writeFileSync(join(dir, '.credentials.json'), JSON.stringify(data));
const read = () => JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8'));
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const profile = () => ({ claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1, scopes: ['a'], subscriptionType: 'max' }, mcpOAuth: { keep: 'me' } });

describe('refreshClaudeProfile', () => {
  it('leaves no temp file and reports transient when the final rename fails', async () => {
    write(profile());
    const fetchSpy = vi.fn(async () => {
      // Replace the file with a directory after it was read, so the rename onto it fails.
      rmSync(join(dir, '.credentials.json'));
      mkdirSync(join(dir, '.credentials.json'));
      return reply(200, { access_token: 'n', expires_in: 60 });
    });
    expect(await refreshClaudeProfile(dir, { fetch: fetchSpy as never, now: () => NOW })).toEqual({ kind: 'transient', detail: { reason: 'write' } });
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('retries storing a rotated token and then reports the login as unusable', async () => {
    write(profile());
    let tries = 0;
    const fetchSpy = vi.fn(async () => {
      tries++;
      rmSync(join(dir, '.credentials.json'), { force: true });
      mkdirSync(join(dir, '.credentials.json'));
      return reply(200, { access_token: 'n', refresh_token: 'rotated', expires_in: 60 });
    });
    const outcome = await refreshClaudeProfile(dir, { fetch: fetchSpy as never, now: () => NOW, delay: async () => undefined });
    expect(outcome).toEqual({ kind: 'unusable' });
    expect(tries).toBe(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('renews the tokens, rotates the refresh token and keeps every other key', async () => {
    write(profile());
    const fetchSpy = vi.fn(async () => reply(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'user:inference user:profile' }));
    expect(await refreshClaudeProfile(dir, { fetch: fetchSpy as never, now: () => NOW })).toEqual({ kind: 'ok' });
    expect(read()).toEqual({
      claudeAiOauth: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: NOW + 3_600_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' },
      mcpOAuth: { keep: 'me' },
    });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: OAUTH_CLIENT_ID });
    expect(init.redirect).toBe('error');
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    write(profile());
    await refreshClaudeProfile(dir, { fetch: (async () => reply(200, { access_token: 'n', expires_in: 60 })) as never, now: () => NOW });
    expect(read().claudeAiOauth).toMatchObject({ accessToken: 'n', refreshToken: 'old-refresh', scopes: ['a'] });
  });

  it('reports a dead login only for an explicit grant rejection', async () => {
    write(profile());
    const dead = (status: number, error: string) => refreshClaudeProfile(dir, { fetch: (async () => reply(status, { error })) as never, now: () => NOW });
    expect(await dead(400, 'invalid_grant')).toEqual({ kind: 'dead' });
    expect(await dead(401, 'invalid_client')).toEqual({ kind: 'dead' });
    expect(await dead(403, 'unauthorized_client')).toEqual({ kind: 'dead' });
    expect(await dead(400, 'something_else')).toEqual({ kind: 'transient', detail: { reason: 'http-400' } });
    expect(await dead(500, 'invalid_grant')).toEqual({ kind: 'transient', detail: { reason: 'http-500' } });
    expect(read().claudeAiOauth.accessToken).toBe('old-access');
  });

  it('treats network errors, garbage bodies and missing files as transient and a missing refresh token as dead', async () => {
    write(profile());
    expect(await refreshClaudeProfile(dir, { fetch: (async () => { throw new Error('offline Bearer old-refresh'); }) as never, now: () => NOW })).toEqual({ kind: 'transient', detail: { reason: 'network' } });
    expect(await refreshClaudeProfile(dir, { fetch: (async () => new Response('<html>', { status: 200 })) as never, now: () => NOW })).toEqual({ kind: 'transient', detail: { reason: 'bad-response' } });
    expect(await refreshClaudeProfile(dir, { fetch: (async () => reply(200, { access_token: '', expires_in: 5 })) as never, now: () => NOW })).toEqual({ kind: 'transient', detail: { reason: 'bad-response' } });
    expect(await refreshClaudeProfile(join(dir, 'missing'), { fetch: vi.fn() as never, now: () => NOW })).toEqual({ kind: 'transient', detail: { reason: 'read' } });
    write({ claudeAiOauth: { accessToken: 'x' } });
    expect(await refreshClaudeProfile(dir, { fetch: vi.fn() as never, now: () => NOW })).toEqual({ kind: 'dead' });
    writeFileSync(join(dir, '.credentials.json'), '{broken');
    expect(await refreshClaudeProfile(dir, { fetch: vi.fn() as never, now: () => NOW })).toEqual({ kind: 'transient', detail: { reason: 'read' } });
  });

  it('reports a rate-limited token endpoint with its Retry-After (seconds or date, capped), without touching the login', async () => {
    write(profile());
    const limited = (headers: Record<string, string>) => refreshClaudeProfile(dir, { fetch: (async () => new Response('{"error":"rate_limit_error"}', { status: 429, headers })) as never, now: () => NOW });
    expect(await limited({ 'retry-after': '120' })).toEqual({ kind: 'transient', detail: { reason: 'http-429', retryAfterMs: 120_000 } });
    expect(await limited({ 'retry-after': new Date(NOW + 90_000).toUTCString() })).toEqual({ kind: 'transient', detail: { reason: 'http-429', retryAfterMs: 90_000 } });
    expect(await limited({ 'retry-after': '999999' })).toEqual({ kind: 'transient', detail: { reason: 'http-429', retryAfterMs: 3_600_000 } });
    expect(await limited({})).toEqual({ kind: 'transient', detail: { reason: 'http-429' } });
    expect(read().claudeAiOauth.refreshToken).toBe('old-refresh');
  });

  it('does not call a login dead when another process renewed this very profile meanwhile', async () => {
    write(profile());
    const fetchSpy = vi.fn(async () => {
      // A Claude session using the same profile wins the race: the server rejects our (now used) token, the file holds the newer pair.
      write({ claudeAiOauth: { accessToken: 'session-access', refreshToken: 'session-refresh', expiresAt: NOW + 3_600_000 } });
      return reply(400, { error: 'invalid_grant' });
    });
    expect(await refreshClaudeProfile(dir, { fetch: fetchSpy as never, now: () => NOW, delay: async () => undefined })).toEqual({ kind: 'ok' });
    expect(read().claudeAiOauth).toMatchObject({ accessToken: 'session-access', refreshToken: 'session-refresh' });
  });

  it('shares one request between concurrent calls for the same profile', async () => {
    write(profile());
    let release!: (value: Response) => void;
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const first = refreshClaudeProfile(dir, { fetch: fetchSpy as never, now: () => NOW });
    const second = refreshClaudeProfile(dir, { fetch: fetchSpy as never, now: () => NOW });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    release(reply(200, { access_token: 'n', refresh_token: 'r2', expires_in: 60 }));
    expect(await first).toEqual({ kind: 'ok' });
    expect(await second).toEqual({ kind: 'ok' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(read().claudeAiOauth.refreshToken).toBe('r2');
  });

  it('never returns or leaves tokens in temporary files', async () => {
    write(profile());
    const outcome = await refreshClaudeProfile(dir, { fetch: (async () => reply(200, { access_token: 'secret-new', expires_in: 60 })) as never, now: () => NOW });
    expect(JSON.stringify(outcome)).not.toContain('secret-new');
    mkdirSync(join(dir, 'x'), { recursive: true });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
