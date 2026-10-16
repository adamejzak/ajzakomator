// The SSH vault (<data>/ssh/vault.json, spec 7.3): key metadata in clear, secrets as safeStorage blobs. Main only.
import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { KEY_ALGOS, type SshKeyAlgo, type SshKeyInfo, type SshVaultInfo } from '../../shared/ssh';
import { ensurePrivateDir, readJsonFile, writePrivateFile } from './files';

export interface Cipher {
  readonly storage: 'dpapi' | 'keychain' | 'unavailable';
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface SafeStorageLike { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string; getSelectedStorageBackend?(): string }

/** safeStorage behind the Cipher interface. Only Windows (DPAPI) and macOS (Keychain) count as available (D8). */
export function electronCipher(safeStorage: SafeStorageLike, platform: NodeJS.Platform, forceUnavailable: boolean): Cipher {
  const available = () => !forceUnavailable && (platform === 'win32' || platform === 'darwin') && safeStorage.isEncryptionAvailable();
  return {
    get storage() { return !available() ? 'unavailable' : platform === 'darwin' ? 'keychain' : 'dpapi'; },
    available,
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  };
}

export interface NewKey {
  label: string; type: SshKeyAlgo; bits: number; fingerprint: string; publicKey: string; comment: string; encrypted: boolean;
  privateKey: string; passphrase?: string; savePassphrase: boolean; certificate?: string; source: 'generated' | 'imported';
}

type KeyMetaRecord = Omit<SshKeyInfo, 'ephemeral' | 'locked'>;
interface KeyRecord { meta: KeyMetaRecord; secret: string | null; plain: { privateKey: string; passphrase?: string } | null; locked: boolean }
interface PasswordRecord { hostId: string; updatedAt: number; secret: string | null; plain: string | null; locked: boolean }

const VERSION = 1;
const ALGOS = new Set<string>(KEY_ALGOS);
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (v: unknown, max = 4000) => (typeof v === 'string' && v.length <= max ? v : undefined);

export class SshVault {
  private keys: KeyRecord[] = [];
  private passwords: PasswordRecord[] = [];
  /** A newer version, an unreadable file or one of the wrong shape: nothing is ever written over it (no stored secret is lost). */
  private newer = false;
  /** D7: passphrases typed into a prompt with "remember until the app quits". Never written. */
  private rememberedPassphrases = new Map<string, string>();
  /** Saved passphrases already checked against their key this run (preflight M2: the bcrypt check is not repeated per connect).
   *  Only a SHA-256 of the passphrase is kept, never a second plaintext copy. */
  private verifiedPassphrases = new Map<string, string>();

  constructor(private readonly file: string, private readonly cipher: Cipher, private readonly now: () => number = Date.now) {
    const read = readJsonFile(file);
    if (!read.ok) {
      // Missing, or unparsable and moved to vault.json.bak: start empty. Still there means it could not be read: keep it untouched.
      if (existsSync(file)) this.newer = true;
      return;
    }
    const v = read.value as { version?: unknown; keys?: unknown; passwords?: unknown };
    if (!isObject(v) || (v.keys !== undefined && !Array.isArray(v.keys)) || (v.passwords !== undefined && !Array.isArray(v.passwords))) {
      this.newer = true;
      return;
    }
    if (typeof v.version === 'number' && v.version > VERSION) this.newer = true;
    const rawKeys: unknown[] = Array.isArray(v.keys) ? v.keys : [];
    const rawPasswords: unknown[] = Array.isArray(v.passwords) ? v.passwords : [];
    for (const raw of rawKeys) {
      if (!isObject(raw)) continue;
      const k = raw;
      const id = str(k.id, 64), label = str(k.label, 80), type = str(k.type, 40), fingerprint = str(k.fingerprint, 100), publicKey = str(k.publicKey, 20000), secret = str(k.secret, 400000);
      if (!id || label === undefined || !type || !ALGOS.has(type) || !fingerprint || !publicKey || !secret) continue;
      this.keys.push({ meta: {
        id, label, type: type as SshKeyAlgo, bits: typeof k.bits === 'number' ? k.bits : 0, fingerprint, publicKey, comment: str(k.comment, 200) ?? '',
        encrypted: k.encrypted === true, passphraseSaved: k.passphraseSaved === true, ...(str(k.certificate, 20000) ? { certificate: str(k.certificate, 20000) } : {}),
        source: k.source === 'generated' ? 'generated' : 'imported', createdAt: typeof k.createdAt === 'number' ? k.createdAt : 0,
      }, secret, plain: null, locked: false });
    }
    for (const raw of rawPasswords) {
      if (!isObject(raw)) continue;
      const hostId = str(raw.hostId, 64), secret = str(raw.secret, 20000);
      if (hostId && secret) this.passwords.push({ hostId, updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0, secret, plain: null, locked: false });
    }
    // An entry this version cannot read would be dropped by the next write: open read-only instead.
    if (this.keys.length !== rawKeys.length || this.passwords.length !== rawPasswords.length) this.newer = true;
    // DPAPI decrypts without a prompt, so locked entries are known at once (spec 7.3). The Keychain stays lazy: no prompt at startup,
    // and a denial is retried on the next use. The decrypted values are dropped right away.
    if (this.cipher.storage === 'dpapi') {
      for (const k of this.keys) this.keySecret(k.meta.id);
      for (const p of this.passwords) this.password(p.hostId);
    }
  }

  readOnly(): boolean { return this.newer; }

  private infoOf(r: KeyRecord): SshKeyInfo { return { ...r.meta, ephemeral: r.secret === null, locked: r.locked }; }

  info(): SshVaultInfo {
    return {
      storage: this.cipher.storage,
      keys: this.keys.map((r) => this.infoOf(r)),
      savedPasswords: this.passwords.map((p) => p.hostId),
      lockedPasswords: this.passwords.filter((p) => p.locked).map((p) => p.hostId),
      readOnly: this.newer,
    };
  }

  key(id: string): SshKeyInfo | undefined { const r = this.keys.find((k) => k.meta.id === id); return r && this.infoOf(r); }
  findByFingerprint(fp: string): SshKeyInfo | undefined { const r = this.keys.find((k) => k.meta.fingerprint === fp); return r && this.infoOf(r); }

  private seal(value: string): string | null {
    return this.cipher.available() ? this.cipher.encrypt(value).toString('base64') : null;
  }

  private open(secret: string): string | null {
    try { return this.cipher.decrypt(Buffer.from(secret, 'base64')); } catch { return null; }
  }

  addKey(k: NewKey): { ok: true; key: SshKeyInfo; duplicate: boolean } | { ok: false; error: 'readOnly' } {
    if (this.newer) return { ok: false, error: 'readOnly' };
    const existing = this.keys.find((r) => r.meta.fingerprint === k.fingerprint);
    if (existing) return { ok: true, key: this.infoOf(existing), duplicate: true };
    const plain = { privateKey: k.privateKey, ...(k.savePassphrase && k.passphrase ? { passphrase: k.passphrase } : {}) };
    const secret = this.seal(JSON.stringify(plain));
    const record: KeyRecord = {
      meta: {
        id: randomUUID(), label: k.label.slice(0, 80), type: k.type, bits: k.bits, fingerprint: k.fingerprint, publicKey: k.publicKey, comment: k.comment,
        encrypted: k.encrypted, passphraseSaved: !!plain.passphrase, ...(k.certificate ? { certificate: k.certificate } : {}), source: k.source, createdAt: this.now(),
      },
      secret, plain: secret === null ? plain : null, locked: false,
    };
    const next = [...this.keys, record];
    this.write(next, this.passwords);
    this.keys = next;
    return { ok: true, key: this.infoOf(record), duplicate: false };
  }

  keySecret(id: string): { ok: true; privateKey: string; passphrase?: string } | { ok: false; error: 'keyMissing' | 'keyLocked' } {
    const r = this.keys.find((k) => k.meta.id === id);
    if (!r) return { ok: false, error: 'keyMissing' };
    if (r.plain) return { ok: true, ...r.plain };
    const text = r.secret ? this.open(r.secret) : null;
    if (text === null) { r.locked = true; return { ok: false, error: 'keyLocked' }; }
    r.locked = false;
    try {
      const parsed = JSON.parse(text) as { privateKey?: unknown; passphrase?: unknown };
      if (typeof parsed.privateKey !== 'string') throw new Error('shape');
      return { ok: true, privateKey: parsed.privateKey, ...(typeof parsed.passphrase === 'string' ? { passphrase: parsed.passphrase } : {}) };
    } catch { r.locked = true; return { ok: false, error: 'keyLocked' }; }
  }

  updateKey(id: string, patch: { label?: string; certificate?: string | null; passphrase?: { save: string } | { forget: true } }): { ok: true; key: SshKeyInfo } | { ok: false; error: 'notFound' | 'readOnly' | 'keyLocked' | 'failed' } {
    if (this.newer) return { ok: false, error: 'readOnly' };
    const r = this.keys.find((k) => k.meta.id === id);
    if (!r) return { ok: false, error: 'notFound' };
    const updated: KeyRecord = { ...r, meta: { ...r.meta } };
    if (patch.passphrase) {
      // A stored key must be sealed again; without encryption it would turn memory-only and vanish from the file on the next write.
      if (r.secret !== null && !this.cipher.available()) return { ok: false, error: 'failed' };
      const current = this.keySecret(id);
      if (!current.ok) return { ok: false, error: 'keyLocked' };
      const plain = { privateKey: current.privateKey, ...('save' in patch.passphrase ? { passphrase: patch.passphrase.save } : {}) };
      const secret = r.secret === null ? null : this.seal(JSON.stringify(plain));
      if (r.secret !== null && secret === null) return { ok: false, error: 'failed' };
      updated.locked = false; // keySecret just decrypted it
      updated.secret = secret;
      updated.plain = secret === null ? plain : null;
      updated.meta.passphraseSaved = !!plain.passphrase;
    }
    if (patch.label !== undefined) updated.meta.label = patch.label.slice(0, 80);
    if (patch.certificate === null) delete updated.meta.certificate;
    else if (patch.certificate !== undefined) updated.meta.certificate = patch.certificate;
    const next = this.keys.map((k) => (k === r ? updated : k));
    this.write(next, this.passwords);
    this.keys = next;
    if (patch.passphrase) this.rememberedPassphrases.delete(id);
    this.verifiedPassphrases.delete(id);
    return { ok: true, key: this.infoOf(updated) };
  }

  removeKey(id: string): boolean {
    if (this.newer) return false;
    const next = this.keys.filter((k) => k.meta.id !== id);
    if (next.length === this.keys.length) return false;
    this.write(next, this.passwords);
    this.keys = next;
    this.rememberedPassphrases.delete(id);
    this.verifiedPassphrases.delete(id);
    return true;
  }

  remember(keyId: string, passphrase: string): void { this.rememberedPassphrases.set(keyId, passphrase); }
  remembered(keyId: string): string | undefined { return this.rememberedPassphrases.get(keyId); }
  forgetRemembered(): void { this.rememberedPassphrases.clear(); this.verifiedPassphrases.clear(); }
  markVerified(keyId: string, passphrase: string): void { this.verifiedPassphrases.set(keyId, digest(passphrase)); }
  isVerified(keyId: string, passphrase: string): boolean { return this.verifiedPassphrases.get(keyId) === digest(passphrase); }

  setPassword(hostId: string, password: string): { ok: true; ephemeral: boolean } | { ok: false; error: 'readOnly' } {
    if (this.newer) return { ok: false, error: 'readOnly' };
    const secret = this.seal(password);
    const record: PasswordRecord = { hostId, updatedAt: this.now(), secret, plain: secret === null ? password : null, locked: false };
    const next = [...this.passwords.filter((p) => p.hostId !== hostId), record];
    this.write(this.keys, next);
    this.passwords = next;
    return { ok: true, ephemeral: secret === null };
  }

  clearPassword(hostId: string): boolean {
    if (this.newer) return false;
    const next = this.passwords.filter((p) => p.hostId !== hostId);
    if (next.length === this.passwords.length) return false;
    this.write(this.keys, next);
    this.passwords = next;
    return true;
  }

  password(hostId: string): { ok: true; password: string } | { ok: false; error: 'none' | 'locked' } {
    const p = this.passwords.find((x) => x.hostId === hostId);
    if (!p) return { ok: false, error: 'none' };
    if (p.plain !== null) return { ok: true, password: p.plain };
    const text = p.secret ? this.open(p.secret) : null;
    if (text === null) { p.locked = true; return { ok: false, error: 'locked' }; }
    p.locked = false;
    return { ok: true, password: text };
  }

  /** Main calls this after every state change: passwords of hosts that no longer exist are deleted. */
  prunePasswords(hostIds: ReadonlySet<string>): boolean {
    if (this.newer) return false;
    const next = this.passwords.filter((p) => hostIds.has(p.hostId));
    if (next.length === this.passwords.length) return false;
    this.write(this.keys, next);
    this.passwords = next;
    return true;
  }

  /** Writes the given lists; callers adopt them only after this returns, so a failed write leaves memory as it was. */
  private write(allKeys: readonly KeyRecord[], allPasswords: readonly PasswordRecord[]): void {
    if (this.newer) return;
    const keys = allKeys.filter((k) => k.secret !== null);
    const passwords = allPasswords.filter((p) => p.secret !== null);
    if (!keys.length && !passwords.length && !existsSync(this.file)) return; // memory-only vault: nothing touches the disk (D8)
    ensurePrivateDir(dirname(this.file));
    writePrivateFile(this.file, JSON.stringify({
      version: VERSION,
      keys: keys.map((k) => ({ ...k.meta, certificate: k.meta.certificate ?? null, secret: k.secret })),
      passwords: passwords.map((p) => ({ hostId: p.hostId, updatedAt: p.updatedAt, secret: p.secret })),
    }, null, 1));
  }
}
