import { lstatSync, readFileSync, statSync } from 'fs';
import { isAlertEvent, type AlertSettings } from '../shared/alerts';
import { isLocalAbsolutePath, isSoundFile, SOUND_MAX_BYTES } from '../shared/sound';

export type SoundLoad =
  | { ok: true; key: string; data: Uint8Array | null }
  | { ok: false };

/**
 * Reads the user's own sound file for the renderer (which may not load file:// URLs itself).
 * `knownKey` is the key the renderer already decoded: when the file is unchanged no bytes are sent again.
 * Only local absolute paths are read: relative paths, UNC / device paths and symbolic links are refused.
 * Never throws; any problem (no path, bad extension, missing, too big, unreadable) is `{ ok: false }`.
 */
export function loadSoundFile(path: string, knownKey?: string): SoundLoad {
  try {
    if (!path || !isLocalAbsolutePath(path) || !isSoundFile(path)) return { ok: false };
    if (lstatSync(path).isSymbolicLink()) return { ok: false };
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

/**
 * The own sound of one alert event. The path is never taken from the renderer: only the saved setting of that event
 * (set from the native dialog result) is read, and only when it is an own-file choice. Unknown events are refused.
 */
export function loadEventSound(alerts: AlertSettings, event: unknown, knownKey?: unknown): SoundLoad {
  if (!isAlertEvent(event)) return { ok: false };
  const sound = alerts.events[event]?.sound;
  if (sound?.kind !== 'file') return { ok: false };
  return loadSoundFile(sound.path, typeof knownKey === 'string' ? knownKey : undefined);
}
