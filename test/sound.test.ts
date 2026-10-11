import { describe, expect, it } from 'vitest';
import { defaultState, normalizeState } from '../src/shared/state';
import { shouldNotify } from '../src/shared/status';
import {
  createSoundThrottle, isSoundFile, normalizeWaitingSound, normalizeWaitingSoundVolume, shouldPlayWaitingSound, SOUND_THROTTLE_MS,
} from '../src/shared/sound';

describe('shouldPlayWaitingSound', () => {
  it('never plays when off', () => {
    expect(shouldPlayWaitingSound('off', true, false)).toBe(false);
  });

  it('plays for a real transition the user is not looking at', () => {
    expect(shouldPlayWaitingSound('system', true, false)).toBe(true);
    expect(shouldPlayWaitingSound('custom', true, false)).toBe(true);
  });

  it('never plays while the user looks at the cell', () => {
    expect(shouldPlayWaitingSound('system', true, true)).toBe(false);
  });

  it('never plays without a transition', () => {
    expect(shouldPlayWaitingSound('custom', false, false)).toBe(false);
  });

  it('follows the notification gate: restored or launch state never plays', () => {
    // idle -> waiting by heuristic (restore / launch) is not a notifiable transition
    const restored = shouldNotify('idle', 'waiting', 'heuristic');
    expect(shouldPlayWaitingSound('system', restored, false)).toBe(false);
    const real = shouldNotify('working', 'waiting', 'heuristic');
    expect(shouldPlayWaitingSound('system', real, false)).toBe(true);
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

describe('settings normalization', () => {
  it('defaults to off, empty file, volume 70', () => {
    expect(defaultState().settings).toMatchObject({ waitingSound: 'off', waitingSoundFile: '', waitingSoundVolume: 70 });
  });

  it('keeps valid values', () => {
    const raw = JSON.parse(JSON.stringify(defaultState()));
    Object.assign(raw.settings, { waitingSound: 'custom', waitingSoundFile: 'C:\\a\\b.wav', waitingSoundVolume: 30 });
    expect(normalizeState(raw)!.settings).toMatchObject({ waitingSound: 'custom', waitingSoundFile: 'C:\\a\\b.wav', waitingSoundVolume: 30 });
  });

  it('missing or corrupt values fall back to defaults', () => {
    const raw = JSON.parse(JSON.stringify(defaultState()));
    delete raw.settings.waitingSound; delete raw.settings.waitingSoundFile; delete raw.settings.waitingSoundVolume;
    expect(normalizeState(raw)!.settings).toMatchObject({ waitingSound: 'off', waitingSoundFile: '', waitingSoundVolume: 70 });
    Object.assign(raw.settings, { waitingSound: 'loud', waitingSoundFile: 5, waitingSoundVolume: 'x' });
    expect(normalizeState(raw)!.settings).toMatchObject({ waitingSound: 'off', waitingSoundFile: '', waitingSoundVolume: 70 });
  });

  it('clamps and rounds the volume', () => {
    expect(normalizeWaitingSoundVolume(150)).toBe(100);
    expect(normalizeWaitingSoundVolume(-5)).toBe(0);
    expect(normalizeWaitingSoundVolume(33.6)).toBe(34);
    expect(normalizeWaitingSoundVolume(NaN)).toBe(70);
    expect(normalizeWaitingSound(undefined)).toBe('off');
  });
});

describe('isSoundFile', () => {
  it('accepts whitelisted extensions only, case-insensitively', () => {
    for (const name of ['a.wav', 'a.MP3', 'x/y.ogg', 'a.m4a', 'a.aac', 'a.flac']) expect(isSoundFile(name)).toBe(true);
    for (const name of ['a.exe', 'a', 'a.wav.txt', '', 'wav']) expect(isSoundFile(name)).toBe(false);
  });
});
