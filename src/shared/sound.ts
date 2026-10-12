// Shared limits and gates of alert sounds (own files, burst throttle, the "user is looking" gate).

export const SOUND_EXTENSIONS = ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac'] as const;
/** Custom sound files above this size are refused (they are read whole and sent over IPC). */
export const SOUND_MAX_BYTES = 5 * 1024 * 1024;
/** Several cells finishing together must not stack sounds. */
export const SOUND_THROTTLE_MS = 1000;

export function isSoundFile(path: string): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return !!match && (SOUND_EXTENSIONS as readonly string[]).includes(match[1].toLowerCase());
}

/**
 * A local absolute path: a drive path (C:\x or C:/x) or a POSIX path. Relative paths and anything starting with two
 * separators (UNC shares, \\?\ and \\.\ device paths, //host/share) are refused: they could reach the network or devices.
 */
export function isLocalAbsolutePath(path: string): boolean {
  if (/^[\\/]{2}/.test(path)) return false;
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/');
}

/**
 * The shared alert gate: by default nothing is signalled while the user is looking at the cell
 * (`userLooking` = window focused and the cell visible); `alertWhenFocused` signals that case too.
 */
export function shouldAlertUser(transition: boolean, userLooking: boolean, alertWhenFocused: boolean): boolean {
  return transition && (!userLooking || alertWhenFocused);
}

/** Returns a function that says whether a sound may play now; allowed calls open a new quiet window. */
export function createSoundThrottle(windowMs = SOUND_THROTTLE_MS): (now: number) => boolean {
  let last = -Infinity;
  return (now) => {
    if (now - last < windowMs) return false;
    last = now;
    return true;
  };
}
