// Trusted host keys of the app (<data>/ssh/known_hosts.json, spec 5 and 9). Never reads or writes ~/.ssh/known_hosts.
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { knownHostId, type KnownHostInfo } from '../../shared/ssh';
import { keyTypeOfBlob, sha256Fingerprint } from './fingerprint';
import { ensurePrivateDir, readJsonFile, writePrivateFile } from './files';

export interface KnownHostEntry { id: string; host: string; port: number; keyType: string; key: string; fingerprint: string; addedAt: number }
export type HostKeyJudgement =
  | { result: 'match' }
  | { result: 'unknown' }
  | { result: 'newType'; knownTypes: string[] }
  | { result: 'changed'; knownFingerprints: string[] };

const VERSION = 1;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function judgeHostKey(entries: readonly KnownHostEntry[], host: string, port: number, keyType: string, keyBase64: string): HostKeyJudgement {
  const mine = entries.filter((e) => e.host === host && e.port === port);
  if (!mine.length) return { result: 'unknown' };
  const sameType = mine.filter((e) => e.keyType === keyType);
  if (sameType.some((e) => e.key === keyBase64)) return { result: 'match' };
  if (!sameType.length) return { result: 'newType', knownTypes: [...new Set(mine.map((e) => e.keyType))] };
  return { result: 'changed', knownFingerprints: sameType.map((e) => e.fingerprint) };
}

function parseEntry(raw: unknown): KnownHostEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.host !== 'string' || !r.host || typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) return null;
  if (typeof r.key !== 'string' || !BASE64.test(r.key)) return null;
  const blob = Buffer.from(r.key, 'base64');
  const keyType = keyTypeOfBlob(blob);
  if (!keyType) return null;
  return { id: r.id, host: r.host.toLowerCase(), port: r.port, keyType, key: blob.toString('base64'), fingerprint: sha256Fingerprint(blob), addedAt: typeof r.addedAt === 'number' ? r.addedAt : 0 };
}

export class KnownHostsStore {
  private entries: KnownHostEntry[] = [];
  private newer = false;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    const read = readJsonFile(file);
    if (!read.ok) return;
    const value = read.value as { version?: unknown; entries?: unknown };
    if (typeof value?.version === 'number' && value.version > VERSION) { this.newer = true; }
    if (Array.isArray(value?.entries)) this.entries = value.entries.map(parseEntry).filter((e): e is KnownHostEntry => e !== null);
  }

  readOnly(): boolean { return this.newer; }
  list(): KnownHostEntry[] { return [...this.entries]; }

  info(): KnownHostInfo[] {
    return this.entries.map((e) => ({ id: e.id, display: knownHostId(e.host, e.port), keyType: e.keyType, fingerprint: e.fingerprint, addedAt: e.addedAt }));
  }

  judge(host: string, port: number, blob: Buffer): { judgement: HostKeyJudgement; keyType: string; fingerprint: string } {
    const keyType = keyTypeOfBlob(blob) ?? 'unknown';
    return { judgement: judgeHostKey(this.entries, host.toLowerCase(), port, keyType, blob.toString('base64')), keyType, fingerprint: sha256Fingerprint(blob) };
  }

  /** `replace` first removes the entries of that host:port and key type. False when the file is read-only or the blob is malformed.
   *  A failing write throws and leaves the entries in memory unchanged. */
  trust(host: string, port: number, blob: Buffer, mode: 'save' | 'replace'): boolean {
    const keyType = keyTypeOfBlob(blob);
    if (this.newer || !keyType) return false;
    const h = host.toLowerCase();
    const kept = mode === 'replace' ? this.entries.filter((e) => !(e.host === h && e.port === port && e.keyType === keyType)) : this.entries;
    const key = blob.toString('base64');
    const next = kept.some((e) => e.host === h && e.port === port && e.key === key)
      ? kept
      : [...kept, { id: randomUUID(), host: h, port, keyType, key, fingerprint: sha256Fingerprint(blob), addedAt: this.now() }];
    this.write(next);
    this.entries = next;
    return true;
  }

  remove(id: string): boolean {
    if (this.newer) return false;
    const next = this.entries.filter((e) => e.id !== id);
    if (next.length === this.entries.length) return false;
    this.write(next);
    this.entries = next;
    return true;
  }

  /** Writes the given entries; the caller adopts them only after this returns. */
  private write(entries: readonly KnownHostEntry[]): void {
    ensurePrivateDir(dirname(this.file));
    writePrivateFile(this.file, JSON.stringify({ version: VERSION, entries }, null, 1));
  }
}
