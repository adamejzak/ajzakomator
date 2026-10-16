// scripts/smoke-ssh-run.cjs
// Runs under Electron with ELECTRON_RUN_AS_NODE=1: the crypto of the shipped runtime (BoringSSL), not the system OpenSSL.
// Generates every key type the app offers and runs an in-process ssh2 server and client for the algorithm sets below.
'use strict';
const { Server, Client, utils } = require('ssh2');

const KEY_TYPES = [['ed25519', {}], ['ecdsa', { bits: 256 }], ['ecdsa', { bits: 384 }], ['ecdsa', { bits: 521 }], ['rsa', { bits: 2048 }], ['rsa', { bits: 3072 }], ['rsa', { bits: 4096 }]];
const HOST_ALGO = { ed25519: 'ssh-ed25519', ecdsa: 'ecdsa-sha2-nistp256', rsa: 'rsa-sha2-256' };
const CASES = [
  { kex: 'curve25519-sha256', cipher: 'aes128-gcm@openssh.com', host: 'ed25519', user: 'ed25519', required: true },
  { kex: 'ecdh-sha2-nistp256', cipher: 'aes256-ctr', host: 'ecdsa', user: 'ecdsa', required: true },
  { kex: 'curve25519-sha256', cipher: 'aes256-gcm@openssh.com', host: 'rsa', user: 'rsa', required: true },
  // ssh2 drops chacha20 when the runtime lacks the cipher; then it is simply not offered (informational).
  { kex: 'curve25519-sha256', cipher: 'chacha20-poly1305@openssh.com', host: 'ed25519', user: 'rsa', required: false },
];
const gen = (type) => utils.generateKeyPairSync(type, type === 'ed25519' ? {} : { bits: type === 'rsa' ? 2048 : 256 });

let failed = false;
const fail = (msg) => { failed = true; process.stdout.write(`FAIL ${msg}\n`); };
const ok = (msg) => process.stdout.write(`OK   ${msg}\n`);

for (const [type, opts] of KEY_TYPES) {
  try {
    const pair = utils.generateKeyPairSync(type, { ...opts, comment: 'smoke@unimux', passphrase: 'smoke-pass', cipher: 'aes256-ctr', rounds: 16 });
    const parsed = utils.parseKey(pair.private, 'smoke-pass');
    if (parsed instanceof Error || Array.isArray(parsed)) throw parsed;
    if (!parsed.getPublicSSH().length) throw new Error('empty public key');
    const sig = parsed.sign(Buffer.from('x'));
    if (!Buffer.isBuffer(sig)) throw new Error(`cannot sign: ${sig && sig.message}`);
    ok(`generate ${type} ${opts.bits ?? ''} -> ${parsed.type}`);
  } catch (error) { fail(`generate ${type} ${opts.bits ?? ''}: ${error && error.message}`); }
}

function handshake(c) {
  return new Promise((resolve) => {
    const host = gen(c.host);
    const user = gen(c.user);
    const userPub = utils.parseKey(user.public);
    const server = new Server({ hostKeys: [host.private] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey' || ctx.key.algo !== userPub.type || !ctx.key.data.equals(userPub.getPublicSSH())) return ctx.reject(['publickey']);
        if (ctx.signature && userPub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
        ctx.accept();
      });
      client.on('ready', () => client.end());
    });
    server.listen(0, '127.0.0.1', () => {
      const client = new Client();
      let negotiated = null;
      const done = (error) => { try { client.end(); } catch {} server.close(); resolve({ error, negotiated }); };
      const timer = setTimeout(() => done(new Error('timeout')), 15000);
      client.on('handshake', (n) => { negotiated = n; });
      client.on('ready', () => { clearTimeout(timer); done(null); });
      client.on('error', (error) => { clearTimeout(timer); done(error); });
      // connect() throws synchronously when ssh2 filtered the requested algorithm out (unsupported by the runtime).
      try {
        client.connect({
          host: '127.0.0.1', port: server.address().port, username: 'smoke', privateKey: user.private, readyTimeout: 0,
          algorithms: { kex: [c.kex], cipher: [c.cipher], serverHostKey: [HOST_ALGO[c.host]] },
          hostVerifier: () => true,
        });
      } catch (error) { clearTimeout(timer); done(error); }
    });
  });
}

(async () => {
  for (const c of CASES) {
    const label = `${c.kex} + ${c.cipher} + host ${HOST_ALGO[c.host]} + user ${c.user}`;
    const { error, negotiated } = await handshake(c);
    if (!error) ok(`${label} (negotiated ${negotiated && negotiated.cs && negotiated.cs.cipher})`);
    else if (c.required) fail(`${label}: ${error.message}`);
    else process.stdout.write(`INFO ${label} not available in this runtime: ${error.message}\n`);
  }
  process.stdout.write(failed ? 'SSH smoke test FAILED\n' : 'SSH smoke test OK\n');
  process.exit(failed ? 1 : 0);
})();
