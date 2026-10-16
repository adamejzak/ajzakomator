// test/ssh-known-hosts.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyTypeOfBlob, sha256Fingerprint } from '../src/main/ssh/fingerprint';
import { judgeHostKey, KnownHostsStore } from '../src/main/ssh/knownHosts';
import { sshString } from './helpers/sshKeys';

// A fixed public key (generated once from a constant seed, public data only) and the fingerprint `ssh-keygen -lf` prints for it.
const FIXTURE_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIs fixture@unimux';
const FIXTURE_FP = 'SHA256:z/fSv0Z0RZS+Lccbc6ZoOWwt/fbj1VFJGSBKQbo4icE';
const blob = Buffer.from(FIXTURE_LINE.split(' ')[1], 'base64');
const otherBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 9))]);
const rsaBlob = Buffer.concat([sshString('ssh-rsa'), sshString(Buffer.from([1, 0, 1])), sshString(Buffer.alloc(256, 7))]);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-known-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fingerprints', () => {
  it('matches ssh-keygen -lf', () => {
    expect(sha256Fingerprint(blob)).toBe(FIXTURE_FP);
    expect(keyTypeOfBlob(blob)).toBe('ssh-ed25519');
    expect(keyTypeOfBlob(rsaBlob)).toBe('ssh-rsa');
    expect(keyTypeOfBlob(Buffer.from([0, 0, 0, 99, 1]))).toBeNull();
    expect(keyTypeOfBlob(Buffer.alloc(0))).toBeNull();
  });
});

describe('judgeHostKey', () => {
  const entry = (host: string, port: number, b: Buffer) => ({ id: 'e', host, port, keyType: keyTypeOfBlob(b)!, key: b.toString('base64'), fingerprint: sha256Fingerprint(b), addedAt: 1 });
  it('returns all four results', () => {
    const entries = [entry('example.com', 22, blob)];
    expect(judgeHostKey(entries, 'example.com', 22, 'ssh-ed25519', blob.toString('base64'))).toEqual({ result: 'match' });
    expect(judgeHostKey(entries, 'example.com', 2222, 'ssh-ed25519', blob.toString('base64'))).toEqual({ result: 'unknown' });
    expect(judgeHostKey(entries, 'example.com', 22, 'ssh-rsa', rsaBlob.toString('base64'))).toEqual({ result: 'newType', knownTypes: ['ssh-ed25519'] });
    expect(judgeHostKey(entries, 'example.com', 22, 'ssh-ed25519', otherBlob.toString('base64'))).toEqual({ result: 'changed', knownFingerprints: [FIXTURE_FP] });
  });
});

describe('KnownHostsStore', () => {
  const file = () => join(dir, 'ssh', 'known_hosts.json');
  it('saves, matches, replaces and removes; round trips through the file', () => {
    const store = new KnownHostsStore(file(), () => 42);
    expect(store.judge('example.com', 22, blob).judgement).toEqual({ result: 'unknown' });
    expect(store.trust('example.com', 22, blob, 'save')).toBe(true);
    expect(store.trust('example.com', 22, rsaBlob, 'save')).toBe(true);
    const again = new KnownHostsStore(file());
    expect(again.judge('example.com', 22, blob).judgement).toEqual({ result: 'match' });
    expect(again.info().map((i) => [i.display, i.keyType])).toEqual([['example.com', 'ssh-ed25519'], ['example.com', 'ssh-rsa']]);
    again.trust('example.com', 22, otherBlob, 'replace');
    expect(again.list().filter((e) => e.keyType === 'ssh-ed25519').map((e) => e.key)).toEqual([otherBlob.toString('base64')]);
    expect(again.list()).toHaveLength(2);
    expect(again.remove(again.list()[0].id)).toBe(true);
    expect(new KnownHostsStore(file()).list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(file(), 'utf8')).version).toBe(1);
  });

  it('shows ports in the OpenSSH form and keys hosts case-insensitively', () => {
    const store = new KnownHostsStore(file());
    store.trust('Example.COM', 2222, blob, 'save');
    expect(store.info()[0].display).toBe('[example.com]:2222');
    expect(store.judge('example.com', 2222, blob).judgement).toEqual({ result: 'match' });
  });

  it('keeps an unparsable file as .bak and starts empty', () => {
    const store0 = new KnownHostsStore(file());
    store0.trust('a', 22, blob, 'save');
    writeFileSync(file(), '{ broken');
    const store = new KnownHostsStore(file());
    expect(store.list()).toEqual([]);
    expect(existsSync(`${file()}.bak`)).toBe(true);
  });

  it('refuses to write a file of a newer version', () => {
    const store0 = new KnownHostsStore(file());
    store0.trust('a', 22, blob, 'save');
    writeFileSync(file(), JSON.stringify({ version: 2, entries: [] }));
    const store = new KnownHostsStore(file());
    expect(store.readOnly()).toBe(true);
    expect(store.trust('b', 22, blob, 'save')).toBe(false);
    expect(JSON.parse(readFileSync(file(), 'utf8')).version).toBe(2);
  });

  it('leaves memory unchanged when a write fails', () => {
    const store = new KnownHostsStore(file());
    store.trust('a', 22, blob, 'save');
    const before = store.list();
    // A non-empty directory where the file belongs makes the atomic rename throw.
    rmSync(file());
    mkdirSync(join(file(), 'child'), { recursive: true });
    expect(() => store.trust('b', 22, rsaBlob, 'save')).toThrow();
    expect(() => store.trust('a', 22, otherBlob, 'replace')).toThrow();
    expect(() => store.remove(before[0].id)).toThrow();
    expect(store.list()).toEqual(before);
    expect(store.judge('b', 22, rsaBlob).judgement).toEqual({ result: 'unknown' });
  });

  it('stores the canonical base64 of a loaded key', () => {
    const store0 = new KnownHostsStore(file());
    store0.trust('a', 22, rsaBlob, 'save');
    expect(rsaBlob.toString('base64').endsWith('=')).toBe(true);
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    raw.entries[0].key = raw.entries[0].key.replace(/=+$/, '');
    writeFileSync(file(), JSON.stringify(raw));
    const store = new KnownHostsStore(file());
    expect(store.list()[0].key).toBe(rsaBlob.toString('base64'));
    expect(store.judge('a', 22, rsaBlob).judgement).toEqual({ result: 'match' });
  });

  it('drops malformed entries when loading', () => {
    const store0 = new KnownHostsStore(file());
    store0.trust('a', 22, blob, 'save');
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    raw.entries.push({ id: 'x', host: 5 }, { ...raw.entries[0], key: 'not base64!!' });
    writeFileSync(file(), JSON.stringify(raw));
    expect(new KnownHostsStore(file()).list()).toHaveLength(1);
  });
});
