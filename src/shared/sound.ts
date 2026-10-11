// Optional sound when a cell starts waiting for the user. It follows the same gate as the OS notification.

export type WaitingSound = 'off' | 'system' | 'custom';

export const WAITING_SOUNDS: readonly WaitingSound[] = ['off', 'system', 'custom'];
export const SOUND_EXTENSIONS = ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac'] as const;
/** Custom sound files above this size are refused (they are read whole and sent over IPC). */
export const SOUND_MAX_BYTES = 5 * 1024 * 1024;
/** Several cells finishing together must not stack sounds. */
export const SOUND_THROTTLE_MS = 1000;
export const DEFAULT_SOUND_VOLUME = 70;

export function normalizeWaitingSound(value: unknown): WaitingSound {
  return WAITING_SOUNDS.includes(value as WaitingSound) ? (value as WaitingSound) : 'off';
}

export function normalizeWaitingSoundVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : DEFAULT_SOUND_VOLUME;
}

export function isSoundFile(path: string): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return !!match && (SOUND_EXTENSIONS as readonly string[]).includes(match[1].toLowerCase());
}

/** `transition` is the shouldNotify result; `userLooking` = window focused and the cell visible. */
export function shouldPlayWaitingSound(mode: WaitingSound, transition: boolean, userLooking: boolean): boolean {
  return mode !== 'off' && transition && !userLooking;
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
