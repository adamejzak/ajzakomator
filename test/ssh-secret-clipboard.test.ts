import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLIPBOARD_CLEAR_MS, createSecretClipboard } from '../src/shared/sshClipboard';

function fakeClipboard() {
  let content = '';
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const clip = createSecretClipboard({
    read: async () => content,
    write: (text) => { content = text; },
    digest: async (text) => createHash('sha256').update(text).digest('hex'),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const fire = async () => { for (const t of timers.filter((x) => !x.cleared)) { t.cleared = true; t.fn(); } await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  return { clip, timers, fire, get: () => content, set: (text: string) => { content = text; } };
}

describe('copied private key leaves the clipboard (0.9.2)', () => {
  it('clears the clipboard after a minute if it still holds the copied key', async () => {
    const f = fakeClipboard();
    await f.clip.copy('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret');
    expect(f.get()).toContain('secret');
    expect(f.timers[0].ms).toBe(CLIPBOARD_CLEAR_MS);
    expect(CLIPBOARD_CLEAR_MS).toBe(60_000);
    await f.fire();
    expect(f.get()).toBe('');
  });

  it('leaves something else the user copied meanwhile alone', async () => {
    const f = fakeClipboard();
    await f.clip.copy('secret');
    f.set('a command the user copied later');
    await f.fire();
    expect(f.get()).toBe('a command the user copied later');
  });

  it('restarts the wait on a second copy', async () => {
    const f = fakeClipboard();
    await f.clip.copy('one');
    await f.clip.copy('two');
    expect(f.timers.map((t) => t.cleared)).toEqual([true, false]);
    await f.fire();
    expect(f.get()).toBe('');
  });
});
