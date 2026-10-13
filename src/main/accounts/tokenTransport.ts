import http from 'http';
import https from 'https';

/**
 * A request path whose headers are exactly the ones given: no Chromium additions (`sec-fetch-*`, `accept-language`, a
 * `Mozilla/5.0 ... Electron` User-Agent), which is what bot protection in front of the token endpoint reacts to. Only
 * Host, Content-Length and Connection are added, like a plain script would (claude-swap does the same through urllib).
 */
const MAX_BODY_BYTES = 1_000_000;

/** The connection to the server was never established, so nothing was sent and the same request may safely be tried by another path. */
export class ConnectFailure extends Error {
  readonly connectFailure = true;
  constructor(readonly code?: string) { super('connect failed'); this.name = 'ConnectFailure'; }
}
export const isConnectFailure = (error: unknown): error is ConnectFailure => error instanceof ConnectFailure;

export function directFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const url = new URL(String(input));
    const secure = url.protocol === 'https:';
    const body = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : undefined;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    if (body) headers['content-length'] = String(body.length);
    headers.connection = 'close';
    let connected = false;
    let settled = false;
    const fail = (error: unknown): void => { if (!settled) { settled = true; reject(error); } };
    const request = (secure ? https : http).request(url, { method: init.method ?? 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { request.destroy(new Error('response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && init.redirect === 'error') { fail(new TypeError('redirect refused')); return; }
        const answer = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((item) => answer.append(key, item));
          else if (typeof value === 'string') answer.set(key, value);
        }
        settled = true;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: answer }));
      });
    });
    request.on('socket', (socket) => { socket.once(secure ? 'secureConnect' : 'connect', () => { connected = true; }); });
    request.on('error', (error: NodeJS.ErrnoException) => fail(connected || error.name === 'AbortError' ? error : new ConnectFailure(error.code)));
    const signal = init.signal;
    if (signal) {
      const abort = (): void => { const error = new Error('aborted'); error.name = 'AbortError'; request.destroy(error); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }
    request.end(body);
  });
}

/** Direct request first; only when no connection could be made (for example a proxy-only network) the fallback, which follows the system proxy, is tried. */
export function createTokenFetch(fallback: typeof fetch, direct: typeof fetch = directFetch as typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await direct(input, init); } catch (error) {
      if (isConnectFailure(error) && !init?.signal?.aborted) return fallback(input, init);
      throw error;
    }
  }) as typeof fetch;
}
