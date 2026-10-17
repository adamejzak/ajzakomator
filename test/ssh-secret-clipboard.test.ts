import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLIPBOARD_CLEAR_MS, createSecretClipboard } from '../src/shared/sshClipboard';

function fakeClipboard() {
  let content = '';
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const digests: string[] = [];
  const clip = createSecretClipboard({
    read: async () => content,
    write: (text) => { content = text; },
    digest: (text) => { const d = createHash('sha256').update(text).digest('hex'); digests.push(d); return d; },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const fire = async () => { for (const t of timers.filter((x) => !x.cleared)) { t.cleared = true; t.fn(); } await new Promise((r) => setTimeout(r, 0)); };
  return { clip, timers, digests, fire, get: () => content, set: (text: string) => { content = text; } };
}

describe('copied private key leaves the clipboard (0.9.2, in main since 0.9.3)', async () => {
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

  it('flush (the app quits) clears at once, only while the copied text is still there, and cancels the wait', async () => {
    const f = fakeClipboard();
    await f.clip.copy('secret');
    expect(f.clip.pending()).toBe(true);
    const flushing = f.clip.flush();
    // Pending until the clipboard was read and cleared (a quit waits for it).
    expect(f.clip.pending()).toBe(true);
    await flushing;
    expect(f.get()).toBe('');
    expect(f.timers[0].cleared).toBe(true);
    expect(f.clip.pending()).toBe(false);
    await f.clip.copy('secret');
    f.set('mine');
    await f.clip.flush();
    expect(f.get()).toBe('mine');
    // Nothing pending: a second flush does nothing.
    f.set('');
    await f.clip.flush();
    expect(f.get()).toBe('');
  });

  it('rejects when the clipboard cannot be written (the window shows an error) and starts no wait', async () => {
    const timers: unknown[] = [];
    const clip = createSecretClipboard({
      read: async () => '', write: () => { throw new Error('no clipboard'); }, digest: (t) => t.length.toString(),
      setTimer: (fn, ms) => { timers.push(ms); return ms; }, clearTimer: () => undefined,
    });
    await expect(clip.copy('secret')).rejects.toThrow('no clipboard');
    expect(timers).toEqual([]);
    expect(clip.pending()).toBe(false);
  });

  it('keeps only a digest of the copied text', async () => {
    const f = fakeClipboard();
    await f.clip.copy('secret');
    expect(f.digests[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
