import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { SOUND_MAX_BYTES } from '../src/shared/sound';
import { loadSoundFile } from '../src/main/waitingSound';

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
