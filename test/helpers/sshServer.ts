// In-process SSH server for tests and real-app checks: 127.0.0.1 only, keys generated at run time, user "alice".
// Erasable TypeScript only and no relative imports: scripts/ssh-test-server.mjs loads this file with Node's type stripping.
import ssh2 from 'ssh2';
import type { Connection, ServerChannel } from 'ssh2';

export interface TestServerOptions {
  port?: number;
  /** Accepted password for alice. */
  password?: string;
  /** authorized_keys line accepted for alice. */
  publicKey?: string;
  /** Answer accepted by the keyboard-interactive prompt "Code: ". */
  keyboardCode?: string;
  /** Pre-auth banner. */
  banner?: string;
  /** Printed when a shell opens. */
  greeting?: string;
  /** Accept alice without any credential ("none" method): only for real-app checks of many cells. */
  noAuth?: boolean;
  /** After `exit`: 'reset' answers the client's next packet with a TCP RST, right after exit-status (a hard-closing server). */
  onExit?: 'reset';
}

export interface TestServer {
  port: number;
  /** Raw public key blob of the host key (what the client's host verifier receives). */
  hostKeyBlob: Buffer;
  ptys: Array<{ term: string; cols: number; rows: number }>;
  windowChanges: Array<{ cols: number; rows: number }>;
  /** Everything the shells received, chunk by chunk. */
  input: string[];
  /** Writes to every open shell. */
  write(data: string | Buffer): void;
  /** Writes `total` ASCII bytes to the first shell, waiting for 'drain' when the channel is full. */
  flood(total: number): { done: Promise<void>; sent(): number };
  /** Destroys every client socket (network loss). */
  dropConnections(): void;
  connections(): number;
  close(): Promise<void>;
}

const { Server, utils } = ssh2;

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const host = utils.generateKeyPairSync('ed25519');
  const hostParsed = utils.parseKey(host.public);
  if (hostParsed instanceof Error || Array.isArray(hostParsed)) throw new Error('host key');
  const userKey = opts.publicKey ? utils.parseKey(opts.publicKey) : null;
  if (userKey instanceof Error || Array.isArray(userKey)) throw new Error('user key');
  const methods = [...(userKey ? ['publickey'] : []), ...(opts.password !== undefined ? ['password'] : []), ...(opts.keyboardCode !== undefined ? ['keyboard-interactive'] : [])] as Array<'publickey' | 'password' | 'keyboard-interactive'>;
  const ptys: TestServer['ptys'] = [];
  const windowChanges: TestServer['windowChanges'] = [];
  const input: string[] = [];
  const shells: ServerChannel[] = [];
  const conns = new Set<Connection>();

  const server = new Server({ hostKeys: [host.private], ...(opts.banner ? { banner: opts.banner } : {}) }, (conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    conn.on('error', () => undefined);
    conn.on('authentication', (ctx) => {
      if (ctx.username !== 'alice') return ctx.reject(methods);
      if (opts.noAuth && ctx.method === 'none') return ctx.accept();
      if (ctx.method === 'password' && opts.password !== undefined && ctx.password === opts.password) return ctx.accept();
      if (ctx.method === 'publickey' && userKey && ctx.key.algo === userKey.type && ctx.key.data.equals(userKey.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        return userKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(methods);
      }
      if (ctx.method === 'keyboard-interactive' && opts.keyboardCode !== undefined) {
        return ctx.prompt([{ prompt: 'Code: ', echo: true }], 'Second factor', 'Type the code', (answers) => (answers[0] === opts.keyboardCode ? ctx.accept() : ctx.reject(methods)));
      }
      return ctx.reject(methods);
    });
    conn.on('ready', () => conn.on('session', (accept) => {
      const session = accept();
      session.on('pty', (ok, _no, info) => { ptys.push({ term: info.term, cols: info.cols, rows: info.rows }); ok?.(); });
      session.on('window-change', (ok, _no, info) => { windowChanges.push({ cols: info.cols, rows: info.rows }); ok?.(); });
      session.on('shell', (ok) => {
        const stream = ok();
        shells.push(stream);
        stream.write(opts.greeting ?? 'Welcome to the test server\r\n$ ');
        let line = '';
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          input.push(text);
          for (const ch of text.replace(/\u001b\[20[01]~/g, '')) {
            if (ch !== '\r') { line += ch; stream.write(ch); continue; }
            const command = line.trim();
            line = '';
            if (command === 'exit') {
              stream.exit(3);
              stream.end();
              if (opts.onExit === 'reset') {
                // The client's next packet (its channel close or DISCONNECT) is answered with a TCP RST.
                const sock = (conn as unknown as { _sock: { resetAndDestroy?(): void; destroy(): void; prependOnceListener(e: 'data', f: () => void): void } })._sock;
                sock.prependOnceListener('data', () => { if (sock.resetAndDestroy) sock.resetAndDestroy(); else sock.destroy(); });
              }
              return;
            }
            const tail = /^tail (\d+)$/.exec(command);
            if (tail) {
              // Writes N bytes and a marker, exits and hangs up: the tail must reach a paused (back-pressured) client.
              stream.write(Buffer.alloc(Number(tail[1]), 'x'));
              stream.write('TAIL-END');
              stream.exit(0);
              stream.end();
              setTimeout(() => conn.end(), 100);
              return;
            }
            stream.write(command.startsWith('echo ') ? `\r\n${command.slice(5)}\r\n$ ` : '\r\n$ ');
          }
        });
      });
    }));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    hostKeyBlob: hostParsed.getPublicSSH(),
    ptys, windowChanges, input,
    write: (data) => { for (const s of shells) s.write(data); },
    flood(total) {
      let sent = 0;
      const stream = shells[0];
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const done = (async () => {
        while (sent < total) {
          const part = chunk.subarray(0, Math.min(chunk.length, total - sent));
          sent += part.length;
          if (!stream.write(part)) await new Promise((r) => stream.once('drain', r));
        }
      })();
      return { done, sent: () => sent };
    },
    dropConnections: () => { for (const c of conns) (c as unknown as { _sock: { destroy(): void } })._sock.destroy(); },
    connections: () => conns.size,
    close: () => new Promise<void>((resolve) => { for (const c of conns) c.end(); server.close(() => resolve()); }),
  };
}
