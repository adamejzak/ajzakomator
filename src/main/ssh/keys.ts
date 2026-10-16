// SSH key material in main (spec 7.1, 7.2): generation, parsing and import drafts. Private text never leaves main.
import { randomUUID } from 'crypto';
import { utils, type ParsedKey } from 'ssh2';
import { DEFAULT_KEY_BITS, KEY_ALGOS, KEY_SIZES, SSH_LIMITS, type DraftError, type DraftResult, type SshKeyAlgo, type SshKeyType } from '../../shared/ssh';
import { sha256Fingerprint } from './fingerprint';

export interface KeyMeta { type: SshKeyAlgo; bits: number; fingerprint: string; publicKey: string; comment: string; blob: Buffer }

const sshString = (value: string | Buffer): Buffer => {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(b.length);
  return Buffer.concat([length, b]);
};

/** Fields of an SSH wire blob, each with its length prefix. */
function fields(blob: Buffer, count: number, from = 0): { parts: Buffer[]; end: number } {
  const parts: Buffer[] = [];
  let off = from;
  for (let i = 0; i < count; i++) {
    const n = blob.readUInt32BE(off);
    if (off + 4 + n > blob.length) throw new Error('short blob');
    parts.push(blob.subarray(off, off + 4 + n));
    off += 4 + n;
  }
  return { parts, end: off };
}

function bitsOf(type: SshKeyAlgo, blob: Buffer): number {
  if (type === 'ssh-ed25519') return 256;
  if (type.startsWith('ecdsa-sha2-nistp')) return Number(type.slice('ecdsa-sha2-nistp'.length));
  let n = fields(blob, 3).parts[2].subarray(4);
  while (n.length && n[0] === 0) n = n.subarray(1);
  return n.length ? (n.length - 1) * 8 + Math.floor(Math.log2(n[0])) + 1 : 0;
}

function metaOf(key: ParsedKey): KeyMeta | null {
  const type = key.type as SshKeyAlgo;
  if (!KEY_ALGOS.includes(type)) return null;
  const blob = key.getPublicSSH();
  const comment = (key.comment ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  return { type, bits: bitsOf(type, blob), fingerprint: sha256Fingerprint(blob), publicKey: `${type} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`, comment, blob };
}

/** Is the key text encrypted (PEM Proc-Type, PPK Encryption, OpenSSH cipher name)? Decided without the passphrase. */
function isEncrypted(text: string): boolean {
  if (/^Proc-Type: 4,ENCRYPTED/m.test(text)) return true;
  if (/^Encryption: (?!none\b)/m.test(text)) return true;
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (!m) return false;
  const raw = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  const magic = 'openssh-key-v1\0'.length;
  if (raw.length < magic + 4) return false;
  const n = raw.readUInt32BE(magic);
  return raw.subarray(magic + 4, magic + 4 + n).toString('latin1') !== 'none';
}

export type ParseResult = { ok: true; meta: KeyMeta; encrypted: boolean } | { ok: false; error: DraftError | 'needsPassphrase'; encrypted?: boolean };

export function parsePrivateKey(text: string, passphrase?: string): ParseResult {
  if (Buffer.byteLength(text, 'utf8') > SSH_LIMITS.privateKey) return { ok: false, error: 'tooLarge' };
  const trimmed = text.trim();
  if (/^PuTTY-User-Key-File-3:/m.test(trimmed)) return { ok: false, error: 'ppkV3' };
  if (/^PuTTY-User-Key-File-2: (?!ssh-rsa\b)/m.test(trimmed)) return { ok: false, error: 'unsupportedType' };
  const encrypted = isEncrypted(trimmed);
  const parsed = utils.parseKey(trimmed, passphrase);
  if (parsed instanceof Error) {
    if (/no passphrase given/i.test(parsed.message)) return { ok: false, error: 'needsPassphrase', encrypted: true };
    if (encrypted) return passphrase ? { ok: false, error: 'badPassphrase', encrypted: true } : { ok: false, error: 'needsPassphrase', encrypted: true };
    return { ok: false, error: 'notAKey' };
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) return { ok: false, error: 'notAKey' };
  if (!key.isPrivateKey()) return { ok: false, error: 'publicOnly' };
  const meta = metaOf(key);
  return meta ? { ok: true, meta, encrypted } : { ok: false, error: 'unsupportedType' };
}

export const checkPassphrase = (privateKey: string, passphrase: string): boolean => parsePrivateKey(privateKey, passphrase).ok;

export function publicKeyMatches(meta: KeyMeta, publicText: string): boolean {
  const parsed = utils.parseKey(publicText.trim());
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return !!key && !(key instanceof Error) && key.getPublicSSH().equals(meta.blob);
}

/** Compares the key embedded in an OpenSSH user certificate with the private key (D9: stored, not used to sign in). */
export function certificateCheck(cert: string, meta: KeyMeta): 'match' | 'mismatch' | 'doubt' {
  const m = /^([a-z0-9-]+)-cert-v01@openssh\.com\s+([A-Za-z0-9+/]+={0,2})(?:\s.*)?$/.exec(cert.trim());
  if (!m || m[1] !== meta.type) return 'mismatch';
  try {
    const raw = Buffer.from(m[2], 'base64');
    const head = fields(raw, 2);
    const count = meta.type === 'ssh-ed25519' ? 1 : 2;
    const key = fields(raw, count, head.end).parts;
    return Buffer.concat([sshString(meta.type), ...key]).equals(meta.blob) ? 'match' : 'mismatch';
  } catch { return 'doubt'; }
}

export async function generateKey(req: { type: SshKeyType; bits?: number; comment: string; passphrase?: string }): Promise<{ privateKey: string; meta: KeyMeta }> {
  const bits = req.type === 'ed25519' ? undefined : req.bits ?? DEFAULT_KEY_BITS[req.type];
  if (bits !== undefined && !KEY_SIZES[req.type].includes(bits)) throw new Error('unsupported key size');
  const options = { ...(bits ? { bits } : {}), comment: req.comment, ...(req.passphrase ? { passphrase: req.passphrase, cipher: 'aes256-ctr', rounds: 16 } : {}) };
  // The async variant keeps main responsive while RSA 4096 is generated.
  const pair = await new Promise<{ private: string; public: string }>((resolve, reject) => {
    utils.generateKeyPair(req.type, options as never, (err: Error | null, keys: { private: string; public: string }) => (err ? reject(err) : resolve(keys)));
  });
  const parsed = parsePrivateKey(pair.private, req.passphrase);
  if (!parsed.ok) throw new Error('generated key does not parse');
  return { privateKey: pair.private, meta: parsed.meta };
}

interface Draft { text: string; publicKey?: string; certificate?: string; meta?: KeyMeta; encrypted: boolean; passphrase?: string; certificateWarning?: boolean; created: number }
export interface ReadyDraft { text: string; meta: KeyMeta; encrypted: boolean; passphrase?: string; certificate?: string }

/** Imports in progress (spec 7.2): the private text stays here until committed or discarded (10 minutes at most). */
export class KeyDrafts {
  private drafts = new Map<string, Draft>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 10 * 60_000) {}

  private sweep(): void {
    for (const [id, d] of this.drafts) if (this.now() - d.created > this.ttlMs) this.drafts.delete(id);
  }

  create(input: { privateKey: string; publicKey?: string; certificate?: string }, duplicateOf: (fingerprint: string) => string | undefined): DraftResult {
    this.sweep();
    if (Buffer.byteLength(input.privateKey, 'utf8') > SSH_LIMITS.privateKey) return { ok: false, error: 'tooLarge' };
    const draft: Draft = { text: input.privateKey, publicKey: input.publicKey?.trim() || undefined, certificate: input.certificate?.trim() || undefined, encrypted: false, created: this.now() };
    const id = randomUUID();
    const result = this.evaluate(id, draft, undefined, duplicateOf);
    if (result.ok) this.drafts.set(id, draft);
    return result;
  }

  unlock(draftId: string, passphrase: string, duplicateOf: (fingerprint: string) => string | undefined): DraftResult {
    this.sweep();
    const draft = this.drafts.get(draftId);
    if (!draft) return { ok: false, error: 'readFailed' };
    return this.evaluate(draftId, draft, passphrase, duplicateOf);
  }

  private evaluate(id: string, draft: Draft, passphrase: string | undefined, duplicateOf: (fingerprint: string) => string | undefined): DraftResult {
    const parsed = parsePrivateKey(draft.text, passphrase);
    if (!parsed.ok) {
      if (parsed.error === 'needsPassphrase') { draft.encrypted = true; return { ok: true, draftId: id, comment: '', encrypted: true, needsPassphrase: true }; }
      return { ok: false, error: parsed.error };
    }
    if (draft.publicKey && !publicKeyMatches(parsed.meta, draft.publicKey)) return { ok: false, error: 'mismatch' };
    const cert = draft.certificate ? certificateCheck(draft.certificate, parsed.meta) : 'match';
    if (cert === 'mismatch') return { ok: false, error: 'certMismatch' };
    draft.meta = parsed.meta;
    draft.encrypted = parsed.encrypted;
    draft.passphrase = parsed.encrypted ? passphrase : undefined;
    draft.certificateWarning = cert === 'doubt';
    const duplicate = duplicateOf(parsed.meta.fingerprint);
    return {
      ok: true, draftId: id, type: parsed.meta.type, bits: parsed.meta.bits, fingerprint: parsed.meta.fingerprint, comment: parsed.meta.comment,
      encrypted: parsed.encrypted, needsPassphrase: false, publicKey: parsed.meta.publicKey,
      ...(cert === 'doubt' ? { certificateWarning: true } : {}), ...(duplicate ? { duplicateOf: duplicate } : {}),
    };
  }

  /** Removes and returns a draft that is ready to be stored (parsed, unlocked); null otherwise. */
  take(draftId: string): ReadyDraft | null {
    this.sweep();
    const d = this.drafts.get(draftId);
    if (!d?.meta) return null;
    this.drafts.delete(draftId);
    return { text: d.text, meta: d.meta, encrypted: d.encrypted, passphrase: d.passphrase, certificate: d.certificate };
  }

  discard(draftId: string): void { this.drafts.delete(draftId); }
}
