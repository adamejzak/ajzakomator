import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeLockPaths, LockTimeout, withClaudeLocks } from '../src/main/accounts/claudeLocks';

let home: string;
let paths: { credentials: string; claudeJson: string };
beforeEach(() => {
  // realpath (native): Claude Code's legacy lock is `<realpath(config dir)>.lock`; a short (8.3) temp path would not match.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ajza-locks-')));
  mkdirSync(join(home, '.claude'));
  paths = { credentials: join(home, '.claude', '.credentials.json'), claudeJson: join(home, '.claude.json') };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const primary = () => join(home, '.claude', '.oauth_refresh.lock');
const legacy = () => join(home, '.claude.lock');
const config = () => join(home, '.claude.json.lock');
const fast = { timeoutMs: 400 };
const age = (dir: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(dir, t, t); };

describe('withClaudeLocks', () => {
  it('uses the paths Claude Code uses', async () => {
    expect(await claudeLockPaths(paths)).toEqual({ primary: primary(), legacy: legacy(), config: config() });
  });

  it('holds the credential locks and the config lock while fn runs, and releases them', async () => {
    let seen: boolean[] = [];
    const out = await withClaudeLocks(paths, async () => { seen = [primary(), legacy(), config()].map(existsSync); return 7; }, fast);
    expect(out).toBe(7);
    expect(seen).toEqual([true, true, true]);
    expect([primary(), legacy(), config()].map(existsSync)).toEqual([false, false, false]);
  });

  it('releases on throw', async () => {
    await expect(withClaudeLocks(paths, async () => { throw new Error('boom'); }, fast)).rejects.toThrow('boom');
    expect([primary(), legacy(), config()].map(existsSync)).toEqual([false, false, false]);
  });

  it('waits for a holder that lets go', async () => {
    mkdirSync(legacy());
    setTimeout(() => rmSync(legacy(), { recursive: true }), 300);
    let ran = false;
    await withClaudeLocks(paths, async () => { ran = true; }, { timeoutMs: 3000 });
    expect(ran).toBe(true);
  });

  it('gives up on a live holder without running fn and releases what it took', async () => {
    mkdirSync(legacy());
    let ran = false;
    await expect(withClaudeLocks(paths, async () => { ran = true; }, fast)).rejects.toBeInstanceOf(LockTimeout);
    expect(ran).toBe(false);
    expect(existsSync(primary())).toBe(false);
    expect(existsSync(legacy())).toBe(true); // somebody else's fresh lock is never removed
  });

  it('takes over a credential lock older than 60 s and a config lock older than 10 s', async () => {
    mkdirSync(primary()); age(primary(), 61_000);
    mkdirSync(config()); age(config(), 11_000);
    await withClaudeLocks(paths, async () => undefined, fast);
    expect(existsSync(primary())).toBe(false);
  });

  it('does not take over a credential lock that is only 15 s old', async () => {
    mkdirSync(primary()); age(primary(), 15_000);
    await expect(withClaudeLocks(paths, async () => undefined, fast)).rejects.toBeInstanceOf(LockTimeout);
  });

  it('touches its locks while holding them', async () => {
    await withClaudeLocks(paths, async () => {
      age(primary(), 30_000);
      await new Promise((r) => setTimeout(r, 200));
      expect(Date.now() - statSync(primary()).mtimeMs).toBeLessThan(5_000);
    }, { ...fast, touchMs: 50 });
  });

  it("never creates, reads or removes Claude Code's owner record", async () => {
    const owner = join(home, '.claude', '.oauth_refresh.lock.owner');
    await withClaudeLocks(paths, async () => undefined, fast);
    expect(existsSync(owner)).toBe(false);
    writeFileSync(owner, '{"pid":1}');
    await withClaudeLocks(paths, async () => undefined, fast);
    expect(existsSync(owner)).toBe(true);
  });

  it("never creates Claude Code's directories", async () => {
    rmSync(join(home, '.claude'), { recursive: true });
    await expect(withClaudeLocks(paths, async () => undefined, fast)).rejects.toThrow();
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});
