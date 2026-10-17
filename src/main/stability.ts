// Small, Electron-free rules of the main process's crash handling (tested in test/stability.test.ts).

/** Message and stack of anything thrown, cut to a size a log line can take. */
export function describeError(error: unknown, max = 4000): string {
  let text: string;
  try { text = error instanceof Error ? error.stack ?? error.message : String(error); } catch { text = 'unprintable error'; }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Renderer crashes reloaded by themselves, at most `max` within `windowMs`; after that the user decides (Reload / Quit). */
export function createReloadLimiter(max = 3, windowMs = 60_000): (now: number) => boolean {
  let times: number[] = [];
  return (now) => {
    times = times.filter((t) => now - t < windowMs);
    if (times.length >= max) return false;
    times.push(now);
    return true;
  };
}

/** Reports from the renderer, at most `max` per `windowMs` (a render loop that throws must not fill the disk). */
export function createReportLimiter(max = 20, windowMs = 60_000): (now: number) => boolean {
  let start = -Infinity;
  let count = 0;
  return (now) => {
    if (now - start >= windowMs) { start = now; count = 0; }
    if (count >= max) return false;
    count++;
    return true;
  };
}

/** One renderer error report as a log line, or null for anything that is not a report (the renderer is not trusted). */
export function rendererReport(kind: unknown, message: unknown, stack?: unknown): string | null {
  if (typeof kind !== 'string' || !/^[a-z-]{1,24}$/.test(kind) || typeof message !== 'string') return null;
  const text = typeof stack === 'string' && stack ? `${message}\n${stack}` : message;
  return `renderer ${kind}: ${text.slice(0, 4000)}`;
}

/** How long a hung renderer gets before the user is asked whether to wait or reload. */
export const UNRESPONSIVE_GRACE_MS = 10_000;

/** Live notifications kept for their click handlers (Windows drops the handlers of collected ones); the oldest go first. */
export const NOTIFICATION_LIMIT = 50;
export function trimNotifications<T>(set: Set<T>, limit = NOTIFICATION_LIMIT): T[] {
  const dropped: T[] = [];
  for (const item of set) {
    if (set.size <= limit) break;
    set.delete(item);
    dropped.push(item);
  }
  return dropped;
}
