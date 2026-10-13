// src/main/usage/retryAfter.ts

/** A server asking for more than this is waited out in steps of it; manual refreshes still go through. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** `Retry-After` as milliseconds (seconds or an HTTP date), capped; undefined when absent or unusable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return undefined;
    ms = at - nowMs;
  }
  // A positive wait shorter than a second is rounded up to one second: a 0 would mean "retry at once" in a loop.
  return Number.isFinite(ms) && ms > 0 ? Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, Math.round(ms))) : undefined;
}
