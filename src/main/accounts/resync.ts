// Keeps the active account's profile dir a current backup of the live login (cswap's _resync_rotated_backup), so an account
// switched out by another tool is not lost. Read under Claude Code's credential lock (never a half-written switch or refresh)
// and only when the live identity proves the bytes are this account's. The lock is held for the two reads only; the copy is
// written after it is released, so Claude Code never waits for our disk writes or for a profile job. A `live` record's copy
// is never sent to the token endpoint.
import { createHash } from 'crypto';
import { join } from 'path';
import { compareIdentity, identityFromOauthAccount, type AccountIdentity } from '../../shared/accounts';
import { LockTimeout, withClaudeLocks, type LockDeps } from './claudeLocks';
import { withProfileLock } from './refresh';
import type { AccountsStore } from './store';
import { atomicWrite, isRecord, nodeSwapFs, readSnap, type SwapFs } from './swap';

/** `settling`: the live files changed since the previous look; nothing is copied until they read the same twice in a row. */
export type ResyncResult = 'copied' | 'unchanged' | 'mismatch' | 'missing' | 'locked' | 'settling';

export interface ResyncDeps {
  paths: { credentials: string; claudeJson: string };
  store: Pick<AccountsStore, 'dirOf' | 'setFamily'>;
  delay(ms: number): Promise<void>;
  fs?: SwapFs;
  locks?: LockDeps;
  /**
   * Signature of the live files at the previous look, per record (kept by the caller across polls). Claude Code writes the
   * credentials and `.claude.json` separately (a `/login` can be seen with the new tokens and the old identity), so new tokens
   * are copied only once both files read the same as last time. Absent: copied at once (tests of the copy itself).
   */
  seen?: Map<string, string>;
}

/** `sig`: SHA-256 of both live files' text (kept in memory only), so a same-size rewrite in the same millisecond still differs. */
type Live = { oauth: Record<string, unknown>; account: unknown; sig: string };

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
      return { oauth, account, sig: createHash('sha256').update(creds.text).update('|').update(json.text).digest('hex') };
    }, { ...deps.locks, credentialsOnly: true });
  } catch (error) {
    if (error instanceof LockTimeout) return 'locked';
    throw error;
  }
  if (typeof live === 'string') return live;
  const { oauth, account, sig } = live;
  const previous = deps.seen?.get(recordId);
  deps.seen?.set(recordId, sig);
  const dir = deps.store.dirOf(recordId);
  return withProfileLock(dir, async (): Promise<ResyncResult> => {
    const own = await readSnap(fs, join(dir, '.credentials.json'));
    const ownOauth = own && isRecord(own.data.claudeAiOauth) ? own.data.claudeAiOauth : null;
    const ownJson = await readSnap(fs, join(dir, '.claude.json'));
    const sameTokens = !!ownOauth && ownOauth.refreshToken === oauth.refreshToken && ownOauth.accessToken === oauth.accessToken;
    const sameAccount = !!ownJson && JSON.stringify(ownJson.data.oauthAccount) === JSON.stringify(account);
    if (sameTokens && sameAccount) return 'unchanged';
    // New tokens wait until both live files are stable; an identity-only change (organisation renamed) is copied at once.
    if (!sameTokens && deps.seen && previous !== sig) return 'settling';
    await fs.mkdir(dir);
    if (!sameTokens) await atomicWrite(deps, fs, join(dir, '.credentials.json'), JSON.stringify({ ...(own?.data ?? {}), claudeAiOauth: oauth }));
    if (!sameAccount) await atomicWrite(deps, fs, join(dir, '.claude.json'), JSON.stringify({ ...(ownJson?.data ?? {}), oauthAccount: account }, null, 2));
    if (!sameTokens) deps.store.setFamily(recordId, 'live');
    return 'copied';
  });
}
