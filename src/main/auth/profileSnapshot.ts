// The two login files of a saved profile, kept in memory while it is signed in again, so a login that signed in a different
// account (the browser's current one) can be undone. Never logged, never written anywhere else, dropped after the login.
import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import { withClaudeLocks } from '../accounts/claudeLocks';
import { withProfileLock } from '../accounts/refresh';
import { atomicWrite, nodeSwapFs } from '../accounts/swap';

export interface ProfileSnapshot { credentials: string | null; claudeJson: string | null }

const FILES = [['credentials', '.credentials.json'], ['claudeJson', '.claude.json']] as const;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const readText = (dir: string, name: string) => readFile(join(dir, name), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });

/**
 * Taken under the profile lock: it waits for a renewal of this profile in flight and for a restore still queued (a
 * cancelled login), so the snapshot is never a half-renewed login or the other account's files.
 */
export function snapshotProfile(dir: string): Promise<ProfileSnapshot> {
  return withProfileLock(dir, async () => ({ credentials: await readText(dir, '.credentials.json'), claudeJson: await readText(dir, '.claude.json') }));
}

const oauthAccountOf = (text: string | null): string | undefined => {
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const account = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).oauthAccount : undefined;
    return account === undefined || account === null ? undefined : JSON.stringify(account);
  } catch { return undefined; }
};

/**
 * True when the profile's `oauthAccount` exists and differs from the snapshot's. Claude Code writes the login's
 * `oauthAccount` with a fresh `profileFetchedAt`, so even a re-login of the same account changes it.
 */
export async function identityRewritten(dir: string, snapshot: ProfileSnapshot): Promise<boolean> {
  const now = oauthAccountOf(await readText(dir, '.claude.json'));
  return now !== undefined && now !== oauthAccountOf(snapshot.claudeJson);
}

/** Writes the snapshot back under the profile's own Claude Code locks (a Claude Code using this profile never sees half of it). */
export async function restoreProfile(dir: string, snapshot: ProfileSnapshot): Promise<void> {
  const paths = { credentials: join(dir, '.credentials.json'), claudeJson: join(dir, '.claude.json') };
  await withProfileLock(dir, () => withClaudeLocks(paths, async () => {
    for (const [key, name] of FILES) {
      const text = snapshot[key];
      if (text === null) await rm(join(dir, name), { force: true });
      else await atomicWrite({ delay }, nodeSwapFs, join(dir, name), text);
    }
  }));
}
