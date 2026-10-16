// Keeps the active account's profile dir a current backup of the live login (cswap's _resync_rotated_backup), so an account
// switched out by another tool is not lost. Read under Claude Code's credential lock (never a half-written switch or refresh)
// and only when the live identity proves the bytes are this account's. The lock is held for the two reads only; the copy is
// written after it is released, so Claude Code never waits for our disk writes or for a profile job. A `live` record's copy
// is never sent to the token endpoint.
import { join } from 'path';
import { compareIdentity, identityFromOauthAccount, type AccountIdentity } from '../../shared/accounts';
import { LockTimeout, withClaudeLocks, type LockDeps } from './claudeLocks';
import { withProfileLock } from './refresh';
import type { AccountsStore } from './store';
import { atomicWrite, isRecord, nodeSwapFs, readSnap, type SwapFs } from './swap';

export type ResyncResult = 'copied' | 'unchanged' | 'mismatch' | 'missing' | 'locked';

export interface ResyncDeps {
  paths: { credentials: string; claudeJson: string };
  store: Pick<AccountsStore, 'dirOf' | 'setFamily'>;
  delay(ms: number): Promise<void>;
  fs?: SwapFs;
  locks?: LockDeps;
}

type Live = { oauth: Record<string, unknown>; account: unknown };

export async function resyncActiveBackup(deps: ResyncDeps, recordId: string, expected: AccountIdentity): Promise<ResyncResult> {
  const fs = deps.fs ?? nodeSwapFs;
  let live: Live | ResyncResult;
  try {
    // Only the credential lock: cswap's switch and Claude Code's refresh hold it; the config lock is taken by Claude Code on
    // almost every config write and is not needed for a consistent read.
    live = await withClaudeLocks(deps.paths, async (): Promise<Live | ResyncResult> => {
      const creds = await readSnap(fs, deps.paths.credentials);
      const json = await readSnap(fs, deps.paths.claudeJson);
      const oauth = creds && isRecord(creds.data.claudeAiOauth) ? creds.data.claudeAiOauth : null;
      if (!creds || !json || !oauth || typeof oauth.refreshToken !== 'string' || !oauth.refreshToken) return 'missing';
      const account = json.data.oauthAccount;
      if (compareIdentity(identityFromOauthAccount(account), expected) !== 'same') return 'mismatch';
      return { oauth, account };
    }, { ...deps.locks, credentialsOnly: true });
  } catch (error) {
    if (error instanceof LockTimeout) return 'locked';
    throw error;
  }
  if (typeof live === 'string') return live;
  const { oauth, account } = live;
  const dir = deps.store.dirOf(recordId);
  return withProfileLock(dir, async (): Promise<ResyncResult> => {
    const own = await readSnap(fs, join(dir, '.credentials.json'));
    const ownOauth = own && isRecord(own.data.claudeAiOauth) ? own.data.claudeAiOauth : null;
    if (ownOauth && ownOauth.refreshToken === oauth.refreshToken && ownOauth.accessToken === oauth.accessToken) return 'unchanged';
    await fs.mkdir(dir);
    await atomicWrite(deps, fs, join(dir, '.credentials.json'), JSON.stringify({ ...(own?.data ?? {}), claudeAiOauth: oauth }));
    const ownJson = await readSnap(fs, join(dir, '.claude.json'));
    await atomicWrite(deps, fs, join(dir, '.claude.json'), JSON.stringify({ ...(ownJson?.data ?? {}), oauthAccount: account }, null, 2));
    deps.store.setFamily(recordId, 'live');
    return 'copied';
  });
}
