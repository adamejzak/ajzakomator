// test/ssh-vault.test.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupPath } from '../src/main/ssh/files';
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

  it('never writes a vault file of a newer version and keeps a corrupt one as a timestamped .bak', () => {
    new SshVault(file(), fakeCipher()).setPassword(HOST_A, 'a');
    writeFileSync(file(), JSON.stringify({ version: 9, keys: [], passwords: [] }));
    const newer = new SshVault(file(), fakeCipher());
    expect(newer.readOnly()).toBe(true);
    expect(newer.addKey(key())).toEqual({ ok: false, error: 'readOnly' });
    expect(newer.setPassword(HOST_A, 'b')).toEqual({ ok: false, error: 'readOnly' });
    expect(JSON.parse(readFileSync(file(), 'utf8')).version).toBe(9);
    writeFileSync(file(), '{ nope');
    expect(new SshVault(file(), fakeCipher()).info().keys).toEqual([]);
    expect(readdirSync(join(dir, 'ssh')).filter((n) => n.startsWith('vault.json.bak-'))).toHaveLength(1);
  });

  it('never overwrites an earlier backup when the vault is corrupt again (M5)', () => {
    new SshVault(file(), fakeCipher()).setPassword(HOST_A, 'a');
    writeFileSync(file(), '{ first');
    new SshVault(file(), fakeCipher());
    writeFileSync(file(), '{ second');
    new SshVault(file(), fakeCipher());
    const backups = readdirSync(join(dir, 'ssh')).filter((n) => n.startsWith('vault.json.bak-')).map((n) => readFileSync(join(dir, 'ssh', n), 'utf8'));
    expect(backups.sort()).toEqual(['{ first', '{ second']);
    const at = new Date('2026-10-16T12:34:56.789Z');
    expect(backupPath(file(), at)).toBe(`${file()}.bak-2026-10-16T12-34-56-789Z`);
    writeFileSync(backupPath(file(), at), 'x');
    expect(backupPath(file(), at)).toBe(`${file()}.bak-2026-10-16T12-34-56-789Z-2`);
  });

  it('opens an unreadable vault file read-only and never writes over it', () => {
    // A directory where the file belongs: it exists, but reading it throws (like a transient EBUSY/EACCES lock).
    mkdirSync(join(file(), 'child'), { recursive: true });
    const vault = new SshVault(file(), fakeCipher());
    expect(vault.readOnly()).toBe(true);
    expect(vault.info().readOnly).toBe(true);
    expect(vault.addKey(key())).toEqual({ ok: false, error: 'readOnly' });
    expect(vault.setPassword(HOST_A, 'pw')).toEqual({ ok: false, error: 'readOnly' });
    expect(statSync(file()).isDirectory()).toBe(true);
    expect(existsSync(join(file(), 'child'))).toBe(true);
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['keys that are not a list', '{"version":1,"keys":{},"passwords":[]}'],
    ['malformed entries', '{"version":1,"keys":[null,{"id":5}],"passwords":[{"hostId":"x"}]}'],
  ])('opens a vault file holding %s read-only and keeps its bytes', (_name, text) => {
    mkdirSync(join(dir, 'ssh'), { recursive: true });
    writeFileSync(file(), text);
    const vault = new SshVault(file(), fakeCipher());
    expect(vault.readOnly()).toBe(true);
    expect(vault.addKey(key())).toEqual({ ok: false, error: 'readOnly' });
    expect(vault.setPassword(HOST_A, 'pw')).toEqual({ ok: false, error: 'readOnly' });
    expect(readFileSync(file(), 'utf8')).toBe(text);
  });

  it('keeps one malformed entry safe: the readable ones load, the file is not rewritten', () => {
    new SshVault(file(), fakeCipher()).addKey(key());
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    raw.keys.push({ id: 'from-the-future', type: 'ssh-ed448' });
    const text = JSON.stringify(raw);
    writeFileSync(file(), text);
    const vault = new SshVault(file(), fakeCipher());
    expect(vault.info().keys).toHaveLength(1);
    expect(vault.readOnly()).toBe(true);
    expect(vault.setPassword(HOST_A, 'pw')).toEqual({ ok: false, error: 'readOnly' });
    expect(readFileSync(file(), 'utf8')).toBe(text);
  });

  it('leaves memory unchanged when a write fails, and a retry writes for real', () => {
    const vault = new SshVault(file(), fakeCipher());
    const first = vault.addKey(key());
    vault.setPassword(HOST_A, 'a');
    if (!first.ok) throw new Error('add');
    const before = JSON.stringify(vault.info());
    // A non-empty directory where the file belongs makes the atomic rename throw.
    rmSync(file());
    mkdirSync(join(file(), 'child'), { recursive: true });
    const other = key({ fingerprint: 'SHA256:other', label: 'other' });
    expect(() => vault.addKey(other)).toThrow();
    expect(() => vault.updateKey(first.key.id, { label: 'renamed' })).toThrow();
    expect(() => vault.updateKey(first.key.id, { passphrase: { forget: true } })).toThrow();
    expect(() => vault.removeKey(first.key.id)).toThrow();
    expect(() => vault.setPassword(HOST_B, 'b')).toThrow();
    expect(() => vault.clearPassword(HOST_A)).toThrow();
    expect(() => vault.prunePasswords(new Set())).toThrow();
    expect(JSON.stringify(vault.info())).toBe(before);
    expect(vault.keySecret(first.key.id)).toEqual({ ok: true, privateKey: PRIVATE, passphrase: 'very-secret-passphrase' });
    rmSync(file(), { recursive: true, force: true });
    expect(vault.addKey(other)).toMatchObject({ ok: true, duplicate: false });
    expect(new SshVault(file(), fakeCipher()).info().keys.map((k) => k.label)).toEqual(['laptop', 'other']);
  });

  it('refuses to change the saved passphrase of a stored key while encryption is unavailable', () => {
    let available = true;
    const base = fakeCipher();
    const cipher = { ...base, available: () => available };
    const vault = new SshVault(file(), cipher);
    const r = vault.addKey(key({ savePassphrase: false }));
    if (!r.ok) throw new Error('add');
    available = false;
    expect(vault.updateKey(r.key.id, { passphrase: { save: 'new' } })).toEqual({ ok: false, error: 'failed' });
    expect(vault.updateKey(r.key.id, { passphrase: { forget: true } })).toEqual({ ok: false, error: 'failed' });
    expect(vault.key(r.key.id)).toMatchObject({ ephemeral: false, passphraseSaved: false });
    expect(new SshVault(file(), fakeCipher()).keySecret(r.key.id)).toEqual({ ok: true, privateKey: PRIVATE });
  });

  it.skipIf(process.platform === 'win32')('creates the ssh directory 0700 and the file 0600', () => {
    new SshVault(file(), fakeCipher()).setPassword(HOST_A, 'a');
    expect(statSync(join(dir, 'ssh')).mode & 0o777).toBe(0o700);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('remembers only a digest of a verified passphrase and forgets it with the key (M2)', () => {
    const vault = new SshVault(file(), fakeCipher());
    const added = vault.addKey(key());
    if (!added.ok) throw new Error('add');
    vault.markVerified(added.key.id, 'very-secret-passphrase');
    expect(vault.isVerified(added.key.id, 'very-secret-passphrase')).toBe(true);
    expect(vault.isVerified(added.key.id, 'other')).toBe(false);
    const cache = (vault as unknown as { verifiedPassphrases: Map<string, string> }).verifiedPassphrases;
    expect([...cache.values()].join()).not.toContain('very-secret-passphrase');
    vault.forgetRemembered();
    expect(vault.isVerified(added.key.id, 'very-secret-passphrase')).toBe(false);
    vault.markVerified(added.key.id, 'very-secret-passphrase');
    expect(vault.removeKey(added.key.id)).toBe(true);
    expect(vault.isVerified(added.key.id, 'very-secret-passphrase')).toBe(false);
  });
});
