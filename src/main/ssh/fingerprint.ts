// Public key fingerprints in the OpenSSH format, computed in main from the raw blob the server sent.
import { createHash } from 'crypto';

export function sha256Fingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** The first SSH string of a public key blob ("ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa" ...); null when malformed. */
export function keyTypeOfBlob(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const length = blob.readUInt32BE(0);
  if (length < 1 || length > 64 || 4 + length > blob.length) return null;
  const type = blob.subarray(4, 4 + length).toString('latin1');
  return /^[a-z0-9@.-]+$/.test(type) ? type : null;
}
