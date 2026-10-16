// test/ssh-vault.test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SshVault, type NewKey } from '../src/main/ssh/vault';
import { fakeCipher } from './helpers/sshKeys';

const HOST_A = '00000000-0000-4000-8000-00000000000a';
const HOST_B = '00000000-0000-4000-8000-00000000000b';
const PRIVATE = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-private-material\n-----END OPENSSH PRIVATE KEY-----\n';
const key = (patch: Partial<NewKey> = {}): NewKey => ({
  label: 'laptop', type: 'ssh-ed25519', bits: 256, fingerprint: 'SHA256:abc', publicKey: 'ssh-ed25519 AAAA me@laptop', comment: 'me@laptop',
  encrypted: true, privateKey: PRIVATE, passphrase: 'very-secret-passphrase', savePassphrase: true, source: 'imported', ...patch,
});

let dir: string;
const file = () => join(dir, 'ssh', 'vault.json');
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-vault-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SshVault', () => {
  it('stores keys and passwords encrypted and reads them back', () => {
    const vault = new SshVault(file(), fakeCipher(), () => 7);
    const added = vault.addKey(key());
    expect(added).toMatchObject({ ok: true, duplicate: false, key: { label: 'laptop', passphraseSaved: true, ephemeral: false, locked: false, createdAt: 7 } });
    expect(vault.setPassword(HOST_A, 'hunter2-password')).toEqual({ ok: true, ephemeral: false });
    const again = new SshVault(file(), fakeCipher());
    const id = again.info().keys[0].id;
    expect(again.keySecret(id)).toEqual({ ok: true, privateKey: PRIVATE, passphrase: 'very-secret-passphrase' });
    expect(again.password(HOST_A)).toEqual({ ok: true, password: 'hunter2-password' });
    expect(again.info()).toMatchObject({ storage: 'dpapi', savedPasswords: [HOST_A], lockedPasswords: [], readOnly: false });
  });

  it('writes no secret in plain text or base64 (spec 11)', () => {
    const vault = new SshVault(file(), fakeCipher());
    vault.addKey(key());
    vault.setPassword(HOST_A, 'hunter2-password');
    const raw = readFileSync(file(), 'utf8');
    for (const secret of [PRIVATE, 'secret-private-material', 'very-secret-passphrase', 'hunter2-password']) {
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain(Buffer.from(secret).toString('base64'));
    }
  });

  it('keeps the passphrase out of the blob unless asked to save it', () => {
    const vault = new SshVault(file(), fakeCipher());
    const r = vault.addKey(key({ savePassphrase: false }));
    if (!r.ok) throw new Error('add');
    expect(r.key.passphraseSaved).toBe(false);
    expect(vault.keySecret(r.key.id)).toEqual({ ok: true, privateKey: PRIVATE });
    expect(vault.updateKey(r.key.id, { passphrase: { save: 'later' } })).toMatchObject({ ok: true, key: { passphraseSaved: true } });
    expect(vault.keySecret(r.key.id)).toEqual({ ok: true, privateKey: PRIVATE, passphrase: 'later' });
    expect(vault.updateKey(r.key.id, { passphrase: { forget: true } })).toMatchObject({ ok: true, key: { passphraseSaved: false } });
  });

  it('keeps everything in memory only when encryption is unavailable (D8)', () => {
    const vault = new SshVault(file(), fakeCipher({ available: false }));
    const r = vault.addKey(key());
    expect(r).toMatchObject({ ok: true, key: { ephemeral: true } });
    expect(vault.setPassword(HOST_A, 'pw')).toEqual({ ok: true, ephemeral: true });
    expect(existsSync(file())).toBe(false);
    if (!r.ok) throw new Error('add');
    expect(vault.keySecret(r.key.id)).toMatchObject({ ok: true, privateKey: PRIVATE });
    expect(vault.info().storage).toBe('unavailable');
    expect(new SshVault(file(), fakeCipher({ available: false })).info().keys).toEqual([]);
  });

  it('marks entries locked when they cannot be decrypted, and unlocks them when they can again', () => {
    const vault = new SshVault(file(), fakeCipher());
    vault.addKey(key());
    vault.setPassword(HOST_A, 'pw');
    const foreign = new SshVault(file(), fakeCipher({ broken: true }));
    const id = foreign.info().keys[0].id;
    expect(foreign.keySecret(id)).toEqual({ ok: false, error: 'keyLocked' });
    expect(foreign.password(HOST_A)).toEqual({ ok: false, error: 'locked' });
    expect(foreign.info()).toMatchObject({ keys: [{ locked: true }], lockedPasswords: [HOST_A] });
    expect(new SshVault(file(), fakeCipher()).keySecret(id)).toMatchObject({ ok: true });
  });

  it('checks DPAPI secrets once at load, so locked entries show before the first use (M3)', () => {
    const vault = new SshVault(file(), fakeCipher());
    vault.addKey(key());
    vault.setPassword(HOST_A, 'pw');
    const foreign = new SshVault(file(), fakeCipher({ broken: true }));
    expect(foreign.info().keys[0].locked).toBe(true);
    expect(foreign.info().lockedPasswords).toEqual([HOST_A]);
    expect(new SshVault(file(), fakeCipher()).info()).toMatchObject({ keys: [{ locked: false }], lockedPasswords: [] });
  });

  it('stays lazy for the macOS Keychain, so no prompt appears at startup (M3)', () => {
    new SshVault(file(), fakeCipher()).addKey(key());
    let decrypts = 0;
    const base = fakeCipher({ broken: true });
    const keychain = { ...base, storage: 'keychain' as const, decrypt: (data: Buffer) => { decrypts++; return base.decrypt(data); } };
    const vault = new SshVault(file(), keychain);
    expect(decrypts).toBe(0);
    expect(vault.info().keys[0].locked).toBe(false);
    expect(vault.keySecret(vault.info().keys[0].id)).toEqual({ ok: false, error: 'keyLocked' });
    expect(vault.info().keys[0].locked).toBe(true);
  });

  it('detects duplicates by fingerprint, removes keys and forgets remembered passphrases', () => {
    const vault = new SshVault(file(), fakeCipher());
    const first = vault.addKey(key());
    const second = vault.addKey(key({ label: 'again' }));
    if (!first.ok || !second.ok) throw new Error('add');
    expect(second).toMatchObject({ duplicate: true, key: { id: first.key.id, label: 'laptop' } });
    vault.remember(first.key.id, 'typed');
    expect(vault.remembered(first.key.id)).toBe('typed');
    expect(vault.removeKey(first.key.id)).toBe(true);
    expect(vault.remembered(first.key.id)).toBeUndefined();
    expect(vault.keySecret(first.key.id)).toEqual({ ok: false, error: 'keyMissing' });
  });

  it('prunes the passwords of deleted hosts', () => {
    const vault = new SshVault(file(), fakeCipher());
    vault.setPassword(HOST_A, 'a');
    vault.setPassword(HOST_B, 'b');
    expect(vault.prunePasswords(new Set([HOST_B]))).toBe(true);
    expect(new SshVault(file(), fakeCipher()).info().savedPasswords).toEqual([HOST_B]);
    expect(vault.prunePasswords(new Set([HOST_B]))).toBe(false);
  });

  it('never writes a vault file of a newer version and keeps a corrupt one as .bak', () => {
    new SshVault(file(), fakeCipher()).setPassword(HOST_A, 'a');
    writeFileSync(file(), JSON.stringify({ version: 9, keys: [], passwords: [] }));
    const newer = new SshVault(file(), fakeCipher());
    expect(newer.readOnly()).toBe(true);
    expect(newer.addKey(key())).toEqual({ ok: false, error: 'readOnly' });
    expect(newer.setPassword(HOST_A, 'b')).toEqual({ ok: false, error: 'readOnly' });
    expect(JSON.parse(readFileSync(file(), 'utf8')).version).toBe(9);
    writeFileSync(file(), '{ nope');
    expect(new SshVault(file(), fakeCipher()).info().keys).toEqual([]);
    expect(existsSync(`${file()}.bak`)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('creates the ssh directory 0700 and the file 0600', () => {
    new SshVault(file(), fakeCipher()).setPassword(HOST_A, 'a');
    expect(statSync(join(dir, 'ssh')).mode & 0o777).toBe(0o700);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
});
