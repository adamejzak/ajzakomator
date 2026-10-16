// test/ssh-keys.test.ts
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
import { certificateCheck, checkPassphrase, generateKey, KeyDrafts, parsePrivateKey, publicKeyMatches } from '../src/main/ssh/keys';
import { sha256Fingerprint } from '../src/main/ssh/fingerprint';
import { fakeCertificate, ppkV2Rsa } from './helpers/sshKeys';

const none = () => undefined;

describe('generateKey', () => {
  it.each([['ed25519', undefined, 'ssh-ed25519', 256], ['ecdsa', 256, 'ecdsa-sha2-nistp256', 256], ['ecdsa', 384, 'ecdsa-sha2-nistp384', 384],
    ['ecdsa', 521, 'ecdsa-sha2-nistp521', 521], ['rsa', 2048, 'ssh-rsa', 2048], ['rsa', 3072, 'ssh-rsa', 3072], ['rsa', 4096, 'ssh-rsa', 4096]] as const)(
    '%s %s', async (type, bits, algo, expectedBits) => {
      for (const passphrase of [undefined, 'pass phrase']) {
        const { privateKey, meta } = await generateKey({ type, bits, comment: 'unimux@test', passphrase });
        expect(meta).toMatchObject({ type: algo, bits: expectedBits, comment: 'unimux@test' });
        expect(meta.publicKey).toBe(`${algo} ${meta.blob.toString('base64')} unimux@test`);
        expect(meta.fingerprint).toBe(sha256Fingerprint(meta.blob));
        const again = parsePrivateKey(privateKey, passphrase);
        expect(again.ok && again.meta.fingerprint).toBe(meta.fingerprint);
        expect(again.ok && again.encrypted).toBe(!!passphrase);
      }
    }, 30000);

  it('refuses sizes the generator does not offer', async () => {
    await expect(generateKey({ type: 'rsa', bits: 1024, comment: 'x' })).rejects.toThrow();
    await expect(generateKey({ type: 'ecdsa', bits: 128, comment: 'x' })).rejects.toThrow();
  });
});

describe('parsePrivateKey', () => {
  const ed = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'me@laptop' });
  const enc = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'pw', cipher: 'aes256-ctr', rounds: 16 });
  it('accepts OpenSSH, PEM PKCS#1 RSA, PEM SEC1 EC and PPK v2 RSA', () => {
    expect(parsePrivateKey(ed.private)).toMatchObject({ ok: true, encrypted: false, meta: { type: 'ssh-ed25519', comment: 'me@laptop' } });
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    expect(parsePrivateKey(pem)).toMatchObject({ ok: true, meta: { type: 'ssh-rsa', bits: 2048 } });
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }) as string;
    expect(parsePrivateKey(ec)).toMatchObject({ ok: true, meta: { type: 'ecdsa-sha2-nistp256', bits: 256 } });
    expect(parsePrivateKey(ppkV2Rsa('putty'))).toMatchObject({ ok: true, meta: { type: 'ssh-rsa', comment: 'putty' } });
  });
  it('asks for the passphrase of an encrypted key and checks it', () => {
    expect(parsePrivateKey(enc.private)).toEqual({ ok: false, error: 'needsPassphrase', encrypted: true });
    expect(parsePrivateKey(enc.private, 'nope')).toEqual({ ok: false, error: 'badPassphrase', encrypted: true });
    expect(parsePrivateKey(enc.private, 'pw')).toMatchObject({ ok: true, encrypted: true });
    expect(checkPassphrase(enc.private, 'pw')).toBe(true);
    expect(checkPassphrase(enc.private, 'nope')).toBe(false);
  });
  it('rejects what it cannot use with a clear code', () => {
    expect(parsePrivateKey(ed.public)).toEqual({ ok: false, error: 'publicOnly' });
    expect(parsePrivateKey('hello')).toEqual({ ok: false, error: 'notAKey' });
    expect(parsePrivateKey('x'.repeat(64 * 1024 + 1))).toEqual({ ok: false, error: 'tooLarge' });
    expect(parsePrivateKey('PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\n')).toEqual({ ok: false, error: 'ppkV3' });
    expect(parsePrivateKey('PuTTY-User-Key-File-2: ssh-ed25519\nEncryption: none\nComment: x\n')).toEqual({ ok: false, error: 'unsupportedType' });
    const pkcs8 = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(parsePrivateKey(pkcs8)).toEqual({ ok: false, error: 'notAKey' });
  });
  it('compares pasted public keys and certificates with the private key', () => {
    const r = parsePrivateKey(ed.private);
    if (!r.ok) throw new Error('fixture');
    expect(publicKeyMatches(r.meta, ed.public)).toBe(true);
    expect(publicKeyMatches(r.meta, ssh2.utils.generateKeyPairSync('ed25519').public)).toBe(false);
    expect(publicKeyMatches(r.meta, 'garbage')).toBe(false);
    expect(certificateCheck(fakeCertificate(ed.public), r.meta)).toBe('match');
    expect(certificateCheck(fakeCertificate(ssh2.utils.generateKeyPairSync('ed25519').public), r.meta)).toBe('mismatch');
    expect(certificateCheck('ssh-ed25519-cert-v01@openssh.com AAAA', r.meta)).toBe('doubt');
    expect(certificateCheck('not a certificate', r.meta)).toBe('mismatch');
  });
});

describe('KeyDrafts', () => {
  it('creates, unlocks, flags duplicates and mismatches, and expires drafts', () => {
    let now = 0;
    const drafts = new KeyDrafts(() => now);
    const enc = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'pw', cipher: 'aes256-ctr', rounds: 16 });
    const locked = drafts.create({ privateKey: enc.private }, none);
    expect(locked).toMatchObject({ ok: true, needsPassphrase: true, encrypted: true });
    if (!locked.ok) throw new Error('draft');
    expect(drafts.unlock(locked.draftId, 'nope', none)).toEqual({ ok: false, error: 'badPassphrase' });
    const open = drafts.unlock(locked.draftId, 'pw', () => 'existing-id');
    expect(open).toMatchObject({ ok: true, needsPassphrase: false, type: 'ssh-ed25519', duplicateOf: 'existing-id' });
    const taken = drafts.take(locked.draftId);
    expect(taken?.text).toBe(enc.private);
    expect(taken?.passphrase).toBe('pw');
    expect(drafts.take(locked.draftId)).toBeNull();

    const plain = ssh2.utils.generateKeyPairSync('ed25519');
    expect(drafts.create({ privateKey: plain.private, publicKey: ssh2.utils.generateKeyPairSync('ed25519').public }, none)).toEqual({ ok: false, error: 'mismatch' });
    expect(drafts.create({ privateKey: plain.private, certificate: fakeCertificate(ssh2.utils.generateKeyPairSync('ed25519').public) }, none)).toEqual({ ok: false, error: 'certMismatch' });
    expect(drafts.create({ privateKey: plain.private, certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA' }, none)).toMatchObject({ ok: true, certificateWarning: true });
    const late = drafts.create({ privateKey: plain.private }, none);
    if (!late.ok) throw new Error('draft');
    now = 10 * 60_000 + 1;
    expect(drafts.take(late.draftId)).toBeNull();
  });

  it('never returns private material in a draft result', () => {
    const plain = ssh2.utils.generateKeyPairSync('ed25519');
    const result = new KeyDrafts().create({ privateKey: plain.private }, none);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });
});
