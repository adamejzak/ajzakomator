// src/main/usage/parse.ts
import { clampPercent, type UsageWindow } from '../../shared/usage';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};
const toSeconds = (value: number) => Math.floor(value > 1e12 ? value / 1000 : value);

/** Claude: `{ five_hour: { utilization, resets_at }, seven_day: { ... } }`; null when neither window is usable. */
export function parseClaudeUsage(body: unknown): UsageWindow[] | null {
  if (!isObject(body)) return null;
  const windows: UsageWindow[] = [];
  for (const [key, id] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
    const raw = body[key];
    if (!isObject(raw)) continue;
    const used = num(raw.utilization);
    if (used === undefined) continue;
    const resets = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) : Number.NaN;
    windows.push({ id, usedPercent: clampPercent(used), resetsAt: Number.isFinite(resets) ? Math.floor(resets / 1000) : 0 });
  }
  return windows.length ? windows : null;
}

function codexWindow(raw: unknown, fallback: '5h' | '7d', nowMs: number): UsageWindow | null {
  if (!isObject(raw)) return null;
  const used = num(raw.used_percent) ?? num(raw.utilization);
  if (used === undefined) return null;
  const seconds = num(raw.limit_window_seconds);
  const minutes = num(raw.window_minutes) ?? (seconds !== undefined && seconds > 0 ? seconds / 60 : undefined);
  const id = minutes === undefined ? fallback : minutes <= 24 * 60 ? '5h' : '7d';
  const at = num(raw.resets_at) ?? num(raw.reset_at);
  const after = num(raw.reset_after_seconds) ?? num(raw.resets_in_seconds);
  const resetsAt = at !== undefined ? toSeconds(at) : after !== undefined ? Math.floor(nowMs / 1000 + after) : 0;
  return { id, usedPercent: clampPercent(used), resetsAt };
}

/** Codex limits from the live response or from a session log event (`primary`/`secondary`, optionally nested). */
export function parseCodexRateLimits(body: unknown, nowMs: number): UsageWindow[] | null {
  if (!isObject(body)) return null;
  const hasWindows = (candidate: unknown): candidate is Json =>
    isObject(candidate) && ['primary_window', 'primary', 'secondary_window', 'secondary'].some((key) => isObject(candidate[key]));
  const source = [body.rate_limit, body.rate_limits, body].find(hasWindows);
  if (!source) return null;
  const primary = codexWindow(source.primary_window ?? source.primary, '5h', nowMs);
  const secondary = codexWindow(source.secondary_window ?? source.secondary, '7d', nowMs);
  if (primary && secondary && primary.id === secondary.id) secondary.id = primary.id === '5h' ? '7d' : '5h';
  const windows = [primary, secondary].filter((window): window is UsageWindow => window !== null);
  windows.sort((a, b) => (a.id === b.id ? 0 : a.id === '5h' ? -1 : 1));
  return windows.length ? windows : null;
}

export function parseCodexPlan(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  const nested = isObject(body.rate_limits) ? body.rate_limits.plan_type : undefined;
  const plan = body.plan_type ?? nested;
  return typeof plan === 'string' && plan ? plan : undefined;
}

/** Claims of a JWT; the signature is not checked because the token is only used to label the account. */
export function decodeJwtClaims(token: string): Json | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isObject(claims) ? claims : null;
  } catch { return null; }
}
