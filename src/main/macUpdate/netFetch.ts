/**
 * A small fetch-like layer over Electron's `net.request` (so Chromium's proxy and certificate handling apply) that follows
 * redirects itself: every hop is checked with `isTrustedUpdateUrl` before `followRedirect()` is called, and a hop that is not
 * allowed aborts the request. The Fetch API's `redirect: 'manual'` is not used because Chromium semantics may hand back an
 * opaque redirect without a readable Location. Free of Electron imports: the request factory is injected.
 */
import { isTrustedUpdateUrl } from './feed';

/* eslint-disable @typescript-eslint/no-explicit-any -- the Electron event emitters are loosely typed */
export interface NetResponseLike {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  pause?(): void;
  resume?(): void;
}

export interface NetRequestLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  setHeader(name: string, value: string): void;
  /** Must be called synchronously from the 'redirect' listener, otherwise the request is cancelled. */
  followRedirect(): void;
  abort(): void;
  end(): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface NetFetchDeps {
  request(options: { url: string; method: 'GET'; redirect: 'manual' }): NetRequestLike;
  /** Extra origins allowed besides GitHub (the development feed). */
  trustedOrigins?: string[];
  maxRedirects?: number;
}

export const MAX_NET_REDIRECTS = 5;
const NULL_BODY = new Set([101, 204, 205, 304]);

const abortError = (): Error => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

export function createNetFetch(deps: NetFetchDeps): (url: string, init?: RequestInit) => Promise<Response> {
  const maxRedirects = deps.maxRedirects ?? MAX_NET_REDIRECTS;
  return (url, init = {}) => new Promise<Response>((resolve, reject) => {
    if (!isTrustedUpdateUrl(url, deps.trustedOrigins)) { reject(new Error(`address not allowed: ${url}`)); return; }
    const request = deps.request({ url, method: 'GET', redirect: 'manual' });
    new Headers(init.headers).forEach((value, name) => request.setHeader(name, value));
    const signal = init.signal ?? undefined;
    let settled = false;
    let hops = 0;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fail = (error: Error) => {
      if (stream) { try { stream.error(error); } catch { /* already closed */ } return; }
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onAbort = () => { request.abort(); fail(abortError()); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });

    request.on('redirect', (_status: number, _method: string, redirectUrl: string) => {
      hops += 1;
      if (hops > maxRedirects) { request.abort(); fail(new Error('too many redirects')); return; }
      if (!isTrustedUpdateUrl(redirectUrl, deps.trustedOrigins)) { request.abort(); fail(new Error(`redirect to an address that is not allowed: ${redirectUrl}`)); return; }
      request.followRedirect();
    });
    request.on('response', (response: NetResponseLike) => {
      if (settled) return;
      settled = true;
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      const body = NULL_BODY.has(response.statusCode) ? null : new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          response.on('data', (chunk: Uint8Array) => {
            controller.enqueue(new Uint8Array(chunk));
            // Backpressure: the file system may be slower than the network.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) response.pause?.();
          });
          response.on('end', () => { try { controller.close(); } catch { /* already errored */ } });
          response.on('error', (error: Error) => { try { controller.error(error); } catch { /* already closed */ } });
          response.on('aborted', () => { try { controller.error(abortError()); } catch { /* already closed */ } });
        },
        pull() { response.resume?.(); },
        cancel() { request.abort(); },
      }, { highWaterMark: 1 });
      resolve(new Response(body, { status: response.statusCode, headers }));
    });
    request.on('error', (error: Error) => fail(error));
    request.on('abort', () => fail(abortError()));
    request.end();
  });
}
