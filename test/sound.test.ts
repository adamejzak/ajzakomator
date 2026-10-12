import { describe, expect, it } from 'vitest';
import { createSoundThrottle, isSoundFile, shouldAlertUser, SOUND_THROTTLE_MS } from '../src/shared/sound';

describe('shouldAlertUser', () => {
  it('is the shared gate of the notification and the sound', () => {
    expect(shouldAlertUser(true, false, false)).toBe(true);
    expect(shouldAlertUser(true, true, false)).toBe(false);
    expect(shouldAlertUser(true, true, true)).toBe(true);
    expect(shouldAlertUser(false, false, true)).toBe(false);
  });
});

describe('createSoundThrottle', () => {
  it('allows one sound per window', () => {
    const allow = createSoundThrottle();
    expect(allow(1000)).toBe(true);
    expect(allow(1000)).toBe(false);
    expect(allow(1000 + SOUND_THROTTLE_MS - 1)).toBe(false);
    expect(allow(1000 + SOUND_THROTTLE_MS)).toBe(true);
  });

  it('a suppressed call does not extend the window', () => {
    const allow = createSoundThrottle(1000);
    expect(allow(0)).toBe(true);
    expect(allow(900)).toBe(false);
    expect(allow(1000)).toBe(true);
  });
});

describe('isSoundFile', () => {
  it('accepts whitelisted extensions only, case-insensitively', () => {
    for (const name of ['a.wav', 'a.MP3', 'x/y.ogg', 'a.m4a', 'a.aac', 'a.flac']) expect(isSoundFile(name)).toBe(true);
    for (const name of ['a.exe', 'a', 'a.wav.txt', '', 'wav']) expect(isSoundFile(name)).toBe(false);
  });
});
