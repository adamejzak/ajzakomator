import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { SOUND_MAX_BYTES } from '../src/shared/sound';
import { loadEventSound, loadSoundFile } from '../src/main/alertSound';
import { defaultAlerts, type AlertSettings } from '../src/shared/alerts';

const dir = mkdtempSync(join(tmpdir(), 'mc-sound-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadSoundFile', () => {
  it('reads a small whitelisted file and skips bytes for a known key', () => {
    const file = join(dir, 'a.wav');
    writeFileSync(file, Buffer.from([1, 2, 3]));
    const first = loadSoundFile(file);
    expect(first.ok && first.data && [...first.data]).toEqual([1, 2, 3]);
    const again = loadSoundFile(file, first.ok ? first.key : undefined);
    expect(again).toMatchObject({ ok: true, data: null });
  });

  it('refuses missing, empty, oversized, wrong-extension files and directories without throwing', () => {
    const big = join(dir, 'big.mp3');
    writeFileSync(big, Buffer.alloc(SOUND_MAX_BYTES + 1));
    const empty = join(dir, 'empty.ogg');
    writeFileSync(empty, '');
    const exe = join(dir, 'x.exe');
    writeFileSync(exe, 'x');
    for (const path of [join(dir, 'missing.wav'), big, empty, exe, dir, '']) expect(loadSoundFile(path)).toEqual({ ok: false });
  });
});

describe('loadEventSound', () => {
  const alerts = (patch: Partial<AlertSettings['events']>): AlertSettings => {
    const a = defaultAlerts();
    a.events = { ...a.events, ...patch };
    return a;
  };

  it('reads the saved file of the asked event only', () => {
    const file = join(dir, 'done.wav');
    writeFileSync(file, Buffer.from([9, 8, 7]));
    const a = alerts({ done: { notify: true, sound: { kind: 'file', path: file } } });
    const loaded = loadEventSound(a, 'done');
    expect(loaded.ok && loaded.data && [...loaded.data]).toEqual([9, 8, 7]);
    expect(loadEventSound(a, 'done', loaded.ok ? loaded.key : undefined)).toMatchObject({ ok: true, data: null });
    // the other events have presets, not files
    expect(loadEventSound(a, 'attention')).toEqual({ ok: false });
    expect(loadEventSound(a, 'error')).toEqual({ ok: false });
  });

  it('keeps every file check per event: wrong extension, missing, empty, oversized, directory', () => {
    const exe = join(dir, 'y.exe');
    writeFileSync(exe, 'x');
    const big = join(dir, 'big2.flac');
    writeFileSync(big, Buffer.alloc(SOUND_MAX_BYTES + 1));
    const empty = join(dir, 'empty2.wav');
    writeFileSync(empty, '');
    for (const path of [exe, big, empty, dir, join(dir, 'nope.wav')]) {
      expect(loadEventSound(alerts({ error: { notify: true, sound: { kind: 'file', path } } }), 'error')).toEqual({ ok: false });
    }
  });

  it('never accepts a path or an unknown event from the caller', () => {
    const file = join(dir, 'safe.wav');
    writeFileSync(file, Buffer.from([1]));
    const a = alerts({ done: { notify: true, sound: { kind: 'file', path: file } } });
    for (const event of [file, '__proto__', 'constructor', 'toString', '', undefined, null, 5, { path: file }]) {
      expect(loadEventSound(a, event)).toEqual({ ok: false });
    }
    // a path smuggled in as the known key is only compared, never read
    expect(loadEventSound(a, 'done', join(dir, 'other.wav'))).toMatchObject({ ok: true });
  });

  it('refuses preset, system and off choices', () => {
    for (const sound of [{ kind: 'off' }, { kind: 'system' }, { kind: 'preset', id: 'retro' }] as const) {
      expect(loadEventSound(alerts({ done: { notify: true, sound } }), 'done')).toEqual({ ok: false });
    }
  });
});

describe('loadSoundFile path rules', () => {
  it('refuses relative, UNC and device paths even when the extension is fine', () => {
    for (const path of ['a.wav', './a.wav', '..\\a.wav', 'sounds/a.wav', '\\\\host\\share\\a.wav', '//host/share/a.wav', '\\\\?\\UNC\\host\\share\\a.wav', '\\\\?\\C:\\a.wav', '\\\\.\\pipe\\a.wav']) {
      expect(loadSoundFile(path), path).toEqual({ ok: false });
    }
  });

  it('refuses a symbolic link to a sound file', (ctx) => {
    const target = join(dir, 'real.wav');
    writeFileSync(target, Buffer.from([1, 2]));
    const link = join(dir, 'link.wav');
    try { symlinkSync(target, link); } catch { ctx.skip(); return; } // creating symlinks needs a privilege on Windows
    expect(loadSoundFile(target)).toMatchObject({ ok: true });
    expect(loadSoundFile(link)).toEqual({ ok: false });
  });
});
