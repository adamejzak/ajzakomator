import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withProfileLock } from '../src/main/accounts/refresh';
import { identityRewritten, restoreProfile, snapshotProfile } from '../src/main/auth/profileSnapshot';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ajza-snap-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('puts back exactly the files a re-login replaced, and removes files that did not exist', async () => {
  writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fake-old"}}');
  const snap = await snapshotProfile(dir);
  expect(snap).toEqual({ credentials: '{"claudeAiOauth":{"accessToken":"fake-old"}}', claudeJson: null });
  writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fake-new"}}');
  writeFileSync(join(dir, '.claude.json'), '{"oauthAccount":{"emailAddress":"other@x.com"}}');
  await restoreProfile(dir, snap);
  expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe('{"claudeAiOauth":{"accessToken":"fake-old"}}');
  expect(existsSync(join(dir, '.claude.json'))).toBe(false);
});

it('snapshots a missing profile as empty', async () => {
  const missing = join(dir, 'none');
  expect(await snapshotProfile(missing)).toEqual({ credentials: null, claudeJson: null });
  mkdirSync(missing);
  await restoreProfile(missing, { credentials: null, claudeJson: null });
  expect(existsSync(join(missing, '.credentials.json'))).toBe(false);
});

it('writes the restore under the profile\'s Claude Code locks and releases them afterwards', async () => {
  const profile = join(dir, 'profile');
  mkdirSync(profile);
  writeFileSync(join(profile, '.claude.json'), '{"oauthAccount":{"emailAddress":"old@x.com"}}');
  const snap = await snapshotProfile(profile);
  writeFileSync(join(profile, '.claude.json'), '{"oauthAccount":{"emailAddress":"other@x.com"}}');
  // A Claude Code process of this profile holds its credential lock: the restore waits for it.
  mkdirSync(join(profile, '.oauth_refresh.lock'));
  const restoring = restoreProfile(profile, snap);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(readFileSync(join(profile, '.claude.json'), 'utf8')).toContain('other@x.com');
  rmSync(join(profile, '.oauth_refresh.lock'), { recursive: true });
  await restoring;
  expect(readFileSync(join(profile, '.claude.json'), 'utf8')).toBe('{"oauthAccount":{"emailAddress":"old@x.com"}}');
  expect(existsSync(join(profile, '.oauth_refresh.lock'))).toBe(false);
  expect(existsSync(`${profile}.lock`)).toBe(false);
});

it('takes the snapshot after a renewal or a restore of the profile that is still in flight (profile lock)', async () => {
  writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fake-before"}}');
  let release: () => void = () => {};
  const renewal = withProfileLock(dir, () => new Promise<void>((resolve) => { release = resolve; }));
  const snapping = snapshotProfile(dir);
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeFileSync(join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"fake-renewed"}}');
  release();
  await renewal;
  expect((await snapping).credentials).toBe('{"claudeAiOauth":{"accessToken":"fake-renewed"}}');
});

it('tells when the profile identity was rewritten after the snapshot (never for an unchanged or missing oauthAccount)', async () => {
  const account = (email: string, at: number) => JSON.stringify({ numStartups: at, oauthAccount: { emailAddress: email, profileFetchedAt: at } });
  writeFileSync(join(dir, '.claude.json'), account('old@x.com', 1));
  const snap = await snapshotProfile(dir);
  expect(await identityRewritten(dir, snap)).toBe(false);
  // Other keys of .claude.json change all the time; only oauthAccount counts.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ numStartups: 9, oauthAccount: { emailAddress: 'old@x.com', profileFetchedAt: 1 } }));
  expect(await identityRewritten(dir, snap)).toBe(false);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ numStartups: 9 }));
  expect(await identityRewritten(dir, snap)).toBe(false);
  // A re-login of the same account still writes a fresh profileFetchedAt.
  writeFileSync(join(dir, '.claude.json'), account('old@x.com', 2));
  expect(await identityRewritten(dir, snap)).toBe(true);
  expect(await identityRewritten(dir, { credentials: null, claudeJson: null })).toBe(true);
});
