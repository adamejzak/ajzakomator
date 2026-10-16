import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { restoreProfile, snapshotProfile } from '../src/main/auth/profileSnapshot';

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
