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

export async function snapshotProfile(dir: string): Promise<ProfileSnapshot> {
  const read = (name: string) => readFile(join(dir, name), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  return { credentials: await read('.credentials.json'), claudeJson: await read('.claude.json') };
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
