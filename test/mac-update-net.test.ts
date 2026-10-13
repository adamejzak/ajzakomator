import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createNetFetch, type NetRequestLike, type NetResponseLike } from '../src/main/macUpdate/netFetch';

/** A scripted stand-in for Electron's ClientRequest: `play` decides what the "server" does once `end()` is called. */
class FakeRequest extends EventEmitter implements NetRequestLike {
  headers: Record<string, string> = {};
  followed = 0;
  aborted = false;
  /** Set while a redirect listener runs, to prove followRedirect is called synchronously from it. */
  insideRedirect = false;
  syncFollow = true;
  constructor(readonly options: { url: string }, private readonly play: (request: FakeRequest) => void) { super(); }
  setHeader(name: string, value: string) { this.headers[name] = value; }
  followRedirect() { this.followed += 1; this.syncFollow &&= this.insideRedirect; }
  abort() { this.aborted = true; queueMicrotask(() => this.emit('abort')); }
  end() { queueMicrotask(() => this.play(this)); }
  redirect(to: string, status = 302) { this.insideRedirect = true; this.emit('redirect', status, 'GET', to, {}); this.insideRedirect = false; }
}

class FakeResponse extends EventEmitter implements NetResponseLike {
  paused = 0;
  constructor(readonly statusCode: number, readonly headers: Record<string, string | string[]> = {}) { super(); }
  pause() { this.paused += 1; }
  resume() { /* the test pushes data by hand */ }
}

const setup = (play: (request: FakeRequest) => void, extra: { trustedOrigins?: string[]; maxRedirects?: number } = {}) => {
  const requests: FakeRequest[] = [];
  const fetch = createNetFetch({ request: (options) => { const request = new FakeRequest(options, play); requests.push(request); return request; }, ...extra });
  return { fetch, requests };
};
const GH = 'https://github.com/adamejzak/ajzakomator/releases/download/v1/a.zip';

describe('createNetFetch', () => {
  it('returns the response with status, headers and the streamed body, and sends the request headers', async () => {
    const { fetch, requests } = setup((request) => {
      const response = new FakeResponse(200, { 'content-type': 'application/zip', 'set-cookie': ['a=1', 'b=2'] });
      request.emit('response', response);
      response.emit('data', Buffer.from('hello '));
      response.emit('data', Buffer.from('world'));
      response.emit('end');
    });
    const result = await fetch(GH, { headers: { 'User-Agent': 'x', 'Cache-Control': 'no-cache' } });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('application/zip');
    expect(await result.text()).toBe('hello world');
    expect(requests[0].options).toMatchObject({ url: GH, method: 'GET', redirect: 'manual' });
    expect(requests[0].headers).toMatchObject({ 'user-agent': 'x', 'cache-control': 'no-cache' });
  });

  it('follows redirects between GitHub hosts one hop at a time, calling followRedirect synchronously', async () => {
    const hosts = ['https://objects.githubusercontent.com/a', 'https://release-assets.githubusercontent.com/b'];
    const { fetch, requests } = setup((request) => {
      for (const host of hosts) request.redirect(host);
      const response = new FakeResponse(200);
      request.emit('response', response);
      response.emit('data', Buffer.from('ok'));
      response.emit('end');
    });
    expect(await (await fetch(GH)).text()).toBe('ok');
    expect(requests[0].followed).toBe(2);
    expect(requests[0].syncFollow).toBe(true);
    expect(requests[0].aborted).toBe(false);
  });

  it.each([
    ['plain http', 'http://objects.githubusercontent.com/a'],
    ['another host', 'https://evil.example.com/a'],
    ['a look-alike host', 'https://evilgithubusercontent.com/a'],
    ['a local address', 'https://localhost/a'],
  ])('aborts at a redirect to %s without following it', async (_name, target) => {
    const { fetch, requests } = setup((request) => request.redirect(target));
    await expect(fetch(GH)).rejects.toThrow(/not allowed/);
    expect(requests[0].followed).toBe(0);
    expect(requests[0].aborted).toBe(true);
  });

  it('aborts a redirect chain longer than 5 hops, but allows exactly 5', async () => {
    const chain = (hops: number) => setup((request) => {
      for (let i = 0; i < hops; i++) request.redirect(`https://github.com/hop${i}`);
      if (request.aborted) return;
      const response = new FakeResponse(200);
      request.emit('response', response);
      response.emit('end');
    });
    const six = chain(6);
    await expect(six.fetch(GH)).rejects.toThrow(/too many redirects/);
    expect(six.requests[0].followed).toBe(5);
    expect(six.requests[0].aborted).toBe(true);
    expect((await chain(5).fetch(GH)).status).toBe(200);
  });

  it('hands a 302 without Location back as an ordinary response (the caller rejects it)', async () => {
    const { fetch } = setup((request) => { const response = new FakeResponse(302); request.emit('response', response); response.emit('end'); });
    const result = await fetch(GH);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBeNull();
  });

  it('survives null-body statuses', async () => {
    const { fetch } = setup((request) => { const response = new FakeResponse(304); request.emit('response', response); response.emit('end'); });
    expect((await fetch(GH)).status).toBe(304);
  });

  it('refuses an initial address that is not allowed without creating a request', async () => {
    const { fetch, requests } = setup(() => {});
    await expect(fetch('https://example.com/a')).rejects.toThrow(/not allowed/);
    await expect(fetch('http://github.com/a')).rejects.toThrow(/not allowed/);
    expect(requests).toEqual([]);
  });

  it('allows the origin of a development feed, and only that one', async () => {
    const dev = setup((request) => { request.redirect('http://localhost:8080/final'); const response = new FakeResponse(200); request.emit('response', response); response.emit('end'); }, { trustedOrigins: ['http://localhost:8080'] });
    expect((await dev.fetch('http://localhost:8080/start')).status).toBe(200);
    const other = setup((request) => request.redirect('http://localhost:9090/final'), { trustedOrigins: ['http://localhost:8080'] });
    await expect(other.fetch('http://localhost:8080/start')).rejects.toThrow(/not allowed/);
  });

  it('rejects on network errors and before any response', async () => {
    const { fetch } = setup((request) => request.emit('error', new Error('net::ERR_CONNECTION_RESET')));
    await expect(fetch(GH)).rejects.toThrow('ERR_CONNECTION_RESET');
  });

  it('errors the body stream when the connection breaks mid-download', async () => {
    const { fetch } = setup((request) => {
      const response = new FakeResponse(200);
      request.emit('response', response);
      response.emit('data', Buffer.from('part'));
      response.emit('error', new Error('reset'));
    });
    const result = await fetch(GH);
    await expect(result.text()).rejects.toThrow('reset');
  });

  it('aborts the request when the caller aborts, before and during the download', async () => {
    const before = new AbortController(); before.abort();
    const early = setup(() => {});
    await expect(early.fetch(GH, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(early.requests[0].aborted).toBe(true);

    const controller = new AbortController();
    const during = setup((request) => { request.emit('response', new FakeResponse(200)); });
    const result = await during.fetch(GH, { signal: controller.signal });
    controller.abort();
    expect(during.requests[0].aborted).toBe(true);
    await expect(result.text()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('pauses a fast response while the consumer is slow and cancels the request when the body is cancelled', async () => {
    let response!: FakeResponse;
    const { fetch, requests } = setup((request) => { response = new FakeResponse(200); request.emit('response', response); });
    const result = await fetch(GH);
    response.emit('data', Buffer.from('a'));
    response.emit('data', Buffer.from('b'));
    expect(response.paused).toBeGreaterThan(0);
    const reader = result.body!.getReader();
    await reader.cancel();
    expect(requests[0].aborted).toBe(true);
  });
});
