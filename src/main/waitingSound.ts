import { readFileSync, statSync } from 'fs';
import { isSoundFile, SOUND_MAX_BYTES } from '../shared/sound';

export type SoundLoad =
  | { ok: true; key: string; data: Uint8Array | null }
  | { ok: false };

/**
 * Reads the user's own sound file for the renderer (which may not load file:// URLs itself).
 * `knownKey` is the key the renderer already decoded: when the file is unchanged no bytes are sent again.
 * Never throws; any problem (no path, bad extension, missing, too big, unreadable) is `{ ok: false }`.
 */
export function loadSoundFile(path: string, knownKey?: string): SoundLoad {
  try {
    if (!path || !isSoundFile(path)) return { ok: false };
    const info = statSync(path);
    if (!info.isFile() || info.size === 0 || info.size > SOUND_MAX_BYTES) return { ok: false };
    const key = `${path}|${info.size}|${info.mtimeMs}`;
    if (key === knownKey) return { ok: true, key, data: null };
    const data = readFileSync(path);
    if (data.length > SOUND_MAX_BYTES) return { ok: false };
    return { ok: true, key, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
  } catch {
    return { ok: false };
  }
}
