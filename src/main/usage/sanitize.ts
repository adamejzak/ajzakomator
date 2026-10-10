// src/main/usage/sanitize.ts
import { clampPercent, type ProviderUsage, type UsageStatus, type UsageWindow } from '../../shared/usage';

const STATUSES: UsageStatus[] = ['ok', 'signedOut', 'expired', 'apiKey', 'error'];
const SOURCES = ['live', 'log', 'cache'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value ? value.slice(0, max) : undefined);

/** Rebuilds a usage object from whitelisted fields only, so nothing unknown reaches state, listeners or the cache file. */
export function sanitizeUsage(raw: unknown): ProviderUsage | null {
  if (!isRecord(raw)) return null;
  const { provider, status, source, fetchedAt } = raw;
  if (provider !== 'claude' && provider !== 'codex') return null;
  if (!STATUSES.includes(status as UsageStatus)) return null;
  if (!SOURCES.includes(source as (typeof SOURCES)[number])) return null;
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
  const windows: UsageWindow[] = [];
  for (const entry of Array.isArray(raw.windows) ? raw.windows : []) {
    if (!isRecord(entry) || (entry.id !== '5h' && entry.id !== '7d')) continue;
    const { usedPercent, resetsAt } = entry;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) continue;
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt < 0) continue;
    windows.push({ id: entry.id, usedPercent: clampPercent(usedPercent), resetsAt });
  }
  const plan = text(raw.plan, 120);
  const email = text(raw.email, 120);
  const error = text(raw.error, 64);
  return {
    provider,
    status: status as UsageStatus,
    ...(plan ? { plan } : {}),
    ...(email ? { email } : {}),
    windows,
    fetchedAt,
    source: source as (typeof SOURCES)[number],
    ...(error ? { error } : {}),
  };
}
