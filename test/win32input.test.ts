import { describe, expect, it } from 'vitest';
import { encodeWin32Key, type KeyLike } from '../src/shared/win32input';

const key = (p: Partial<KeyLike> & { mods?: string[] }): KeyLike => ({
  type: 'keydown', code: '', key: '', ctrlKey: false, altKey: false, shiftKey: false,
  getModifierState: (m) => (p.mods ?? []).includes(m),
  ...p,
});

describe('encodeWin32Key', () => {
  it('encodes space down and up', () => {
    expect(encodeWin32Key(key({ code: 'Space', key: ' ' }))).toBe('\x1b[32;57;32;1;0;1_');
    expect(encodeWin32Key(key({ type: 'keyup', code: 'Space', key: ' ' }))).toBe('\x1b[32;57;32;0;0;1_');
  });

  it('encodes Ctrl+C as control char 3 with LEFT_CTRL', () => {
    expect(encodeWin32Key(key({ code: 'KeyC', key: 'c', ctrlKey: true }))).toBe('\x1b[67;46;3;1;8;1_');
  });

  it('encodes AltGr+a (Polish ą) as the character with RIGHT_ALT|LEFT_CTRL', () => {
    const seq = encodeWin32Key(key({ code: 'KeyA', key: 'ą', ctrlKey: true, altKey: true, mods: ['AltGraph'] }))!;
    const [, , uc, , cs] = seq.slice(2, -1).split(';').map(Number);
    expect(uc).toBe(261);
    expect(cs & 0x09).toBe(0x09);
  });

  it('flags arrow keys as enhanced', () => {
    const cs = Number(encodeWin32Key(key({ code: 'ArrowUp', key: 'ArrowUp' }))!.slice(2, -1).split(';')[4]);
    expect(cs & 0x100).toBe(0x100);
  });

  it('includes shift and CapsLock state', () => {
    const seq = encodeWin32Key(key({ code: 'KeyA', key: 'A', shiftKey: true, mods: ['CapsLock'] }))!;
    expect(seq).toBe(`\x1b[65;30;65;1;${0x10 | 0x80};1_`);
  });

  it('returns null for unknown physical keys', () => {
    expect(encodeWin32Key(key({ code: 'Lang1', key: 'x' }))).toBeNull();
  });
});
