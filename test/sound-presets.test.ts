import { describe, expect, it } from 'vitest';
import { defaultAlerts, DEFAULT_EVENT_SOUNDS } from '../src/shared/alerts';
import { messages } from '../src/shared/messages';
import { getPreset, isPresetId, noteGainAt, PRESET_IDS, PRESET_MAX_SECONDS, presetLength, presetPeak, SOUND_PRESETS } from '../src/shared/soundPresets';

describe('sound presets', () => {
  it('ships the required presets with unique ids', () => {
    for (const id of ['ding-dong', 'chime', 'soft-bell', 'marimba', 'pluck', 'retro', 'alert', 'low-warn']) expect(isPresetId(id)).toBe(true);
    expect(new Set(PRESET_IDS).size).toBe(SOUND_PRESETS.length);
    expect(isPresetId('nope')).toBe(false);
    expect(getPreset('nope')).toBeUndefined();
  });

  it.each(SOUND_PRESETS.map((preset) => [preset.id, preset] as const))('%s is valid data', (_id, preset) => {
    expect(preset.notes.length).toBeGreaterThan(0);
    for (const n of preset.notes) {
      for (const value of [n.freq, n.start, n.duration, n.gain, n.attack]) expect(Number.isFinite(value)).toBe(true);
      expect(n.freq).toBeGreaterThanOrEqual(80);
      expect(n.freq).toBeLessThanOrEqual(8000);
      expect(n.start).toBeGreaterThanOrEqual(0);
      expect(n.duration).toBeGreaterThan(0);
      expect(n.attack).toBeGreaterThan(0);
      expect(n.attack).toBeLessThan(n.duration);
      expect(n.gain).toBeGreaterThan(0);
      expect(n.gain).toBeLessThanOrEqual(1);
      expect(['sine', 'triangle', 'square', 'sawtooth']).toContain(n.wave);
    }
    expect(presetLength(preset)).toBeLessThan(PRESET_MAX_SECONDS);
    // The summed envelope never exceeds full scale, so the master volume cannot clip.
    expect(presetPeak(preset)).toBeLessThanOrEqual(1);
    expect(presetPeak(preset)).toBeGreaterThan(0.15);
    expect(Object.hasOwn(messages, preset.label)).toBe(true);
  });

  it('descends for ding-dong and low-warn, ascends for alert', () => {
    const firsts = (id: string) => getPreset(id)!.notes.filter((n) => n.wave === 'sine' || n.wave === 'triangle').sort((a, b) => a.start - b.start);
    const main = (id: string) => [firsts(id)[0], firsts(id).find((n) => n.start > 0.1)!];
    expect(main('ding-dong')[1].freq).toBeLessThan(main('ding-dong')[0].freq);
    expect(main('low-warn')[1].freq).toBeLessThan(main('low-warn')[0].freq);
    expect(main('alert')[1].freq).toBeGreaterThan(main('alert')[0].freq);
  });

  it('envelope fades in, then decays', () => {
    const n = getPreset('soft-bell')!.notes[0];
    expect(noteGainAt(n, -1)).toBe(0);
    expect(noteGainAt(n, n.attack)).toBeCloseTo(n.gain, 5);
    expect(noteGainAt(n, n.duration / 2)).toBeLessThan(n.gain);
    expect(noteGainAt(n, n.duration + 1)).toBe(0);
  });

  it('every default event sound is a known preset', () => {
    for (const sound of Object.values(DEFAULT_EVENT_SOUNDS)) expect(sound.kind === 'preset' && isPresetId(sound.id)).toBe(true);
    expect(defaultAlerts().events.done.sound).toEqual({ kind: 'preset', id: 'ding-dong' });
    expect(defaultAlerts().events.attention.sound).toEqual({ kind: 'preset', id: 'alert' });
    expect(defaultAlerts().events.error.sound).toEqual({ kind: 'preset', id: 'low-warn' });
  });
});
