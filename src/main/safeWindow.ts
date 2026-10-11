/**
 * Guards for windows that outlive their native object: after a window is closed (and while the process
 * winds down for an update) async callbacks still fire, and touching a destroyed window or its
 * webContents throws "Object has been destroyed". Structural types keep this free of Electron imports.
 */

export interface WindowLike {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void };
}

/** True while both the window and its webContents can still be used. */
export function isLive<T extends { isDestroyed(): boolean; webContents: { isDestroyed(): boolean } }>(win: T | null | undefined): win is T {
  if (!win) return false;
  try { return !win.isDestroyed() && !win.webContents.isDestroyed(); } catch { return false; }
}

/** Sends to a window only if it is still alive; true when the message was handed over. Never throws. */
export function safeSend(win: WindowLike | null | undefined, channel: string, ...args: unknown[]): boolean {
  if (!isLive(win)) return false;
  try { win.webContents.send(channel, ...args); return true; } catch { return false; }
}

/** Runs `action` with the window only while it is alive; the result is undefined otherwise. Never throws. */
export function withLiveWindow<W extends { isDestroyed(): boolean }, R>(win: W | null | undefined, action: (win: W) => R): R | undefined {
  try { return win && !win.isDestroyed() ? action(win) : undefined; } catch { return undefined; }
}

export type UncaughtPhase = 'running' | 'shutdown';
export type UncaughtDecision = 'ignore' | 'log' | 'show';

/**
 * What the main process does with an exception nobody caught. "Object has been destroyed" is a race
 * with a closed window and never actionable, so it is only logged. While shutting down (or installing an
 * update) nothing may open a dialog: the blocking native dialog keeps the process alive and the installer
 * waits for it. Real errors during normal operation are still shown, without blocking the event loop.
 */
export function decideUncaught(error: unknown, phase: UncaughtPhase): UncaughtDecision {
  const message = error instanceof Error ? error.message : String(error);
  if (/Object has been destroyed/i.test(message)) return 'log';
  return phase === 'shutdown' ? 'log' : 'show';
}

/** Longest time the process may spend winding down before it exits anyway, so an installer is never kept waiting. */
export const SHUTDOWN_HARD_LIMIT_MS = 20 * 1000;
