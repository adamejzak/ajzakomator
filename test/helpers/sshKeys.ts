// test/helpers/sshKeys.ts
// Key fixtures built in memory for the tests (nothing is written to disk, nothing is a real key of anybody).
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import type { Cipher } from '../../src/main/ssh/vault';

/** ssh2's generateKeyPairSync, retried until ssh2 can read the key back (it writes an unreadable one about 1 in 200 times). */
export function readableKeyPair(type: 'ed25519' | 'ecdsa' | 'rsa', options: Record<string, unknown> = {}): { private: string; public: string } {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync(type as 'ed25519', options as never);
    if (!(ssh2.utils.parseKey(pair.private, options.passphrase as string | undefined) instanceof Error)) return pair;
  }
}

export const sshString = (value: string | Buffer): Buffer => {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(b.length);
  return Buffer.concat([length, b]);
};
const mpint = (b64url: string) => { let b = Buffer.from(b64url, 'base64url'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return sshString(b); };

/** An unencrypted PuTTY PPK v2 RSA key (the only PPK v2 type ssh2 parses), MAC included. */
export function ppkV2Rsa(comment = 'fixture'): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const pub = Buffer.concat([sshString('ssh-rsa'), mpint(j.e), mpint(j.n)]);
  const priv = Buffer.concat([mpint(j.d), mpint(j.p), mpint(j.q), mpint(j.qi)]);
  const macKey = createHash('sha1').update('putty-private-key-file-mac-key').digest();
  const mac = createHmac('sha1', macKey).update(Buffer.concat([sshString('ssh-rsa'), sshString('none'), sshString(comment), sshString(pub), sshString(priv)])).digest('hex');
  const lines = (b: Buffer) => b.toString('base64').match(/.{1,64}/g)!;
  return ['PuTTY-User-Key-File-2: ssh-rsa', 'Encryption: none', `Comment: ${comment}`, `Public-Lines: ${lines(pub).length}`, ...lines(pub),
    `Private-Lines: ${lines(priv).length}`, ...lines(priv), `Private-MAC: ${mac}`, ''].join('\r\n');
}

/** A reversible stand-in for safeStorage: hex inside a marker, so neither the text nor its base64 appear in files. */
export function fakeCipher(opts: { available?: boolean; broken?: boolean } = {}): Cipher {
  const available = opts.available ?? true;
  return {
    storage: available ? 'dpapi' : 'unavailable',
    available: () => available,
    encrypt: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('hex')}`),
    decrypt: (data) => {
      const s = data.toString();
      if (opts.broken || !s.startsWith('enc:')) throw new Error('cannot decrypt');
      return Buffer.from(s.slice(4), 'hex').toString('utf8');
    },
  };
}

/** A syntactically valid OpenSSH user certificate line for the given public key (signature fields are junk; only the embedded key is checked). */
export function fakeCertificate(publicLine: string): string {
  const [type, b64] = publicLine.split(' ');
  const blob = Buffer.from(b64, 'base64');
  let off = 4 + blob.readUInt32BE(0);
  const rest = blob.subarray(off);
  return `${type}-cert-v01@openssh.com ${Buffer.concat([sshString(`${type}-cert-v01@openssh.com`), sshString(Buffer.alloc(32, 1)), rest, Buffer.alloc(40, 2)]).toString('base64')} cert`;
}
