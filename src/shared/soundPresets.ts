// Built-in alert sounds, described as pure data and synthesized with WebAudio in the renderer (no audio assets).
import type { MessageKey } from './i18n';

export type PresetWave = 'sine' | 'triangle' | 'square' | 'sawtooth';

export interface PresetNote {
  /** Hz. */
  freq: number;
  /** Seconds from the start of the sound. */
  start: number;
  /** Seconds; the note fades out exponentially over its whole length. */
  duration: number;
  wave: PresetWave;
  /** Peak gain of this note (0..1) before the master volume. */
  gain: number;
  /** Seconds of fade-in; short, it only avoids a click. */
  attack: number;
}

export type PresetId = 'ding-dong' | 'chime' | 'soft-bell' | 'marimba' | 'pluck' | 'retro' | 'alert' | 'low-warn';

export interface SoundPreset {
  id: PresetId;
  label: MessageKey;
  notes: readonly PresetNote[];
}

/** A preset is never longer than this, so a burst of alerts cannot pile up into noise. */
export const PRESET_MAX_SECONDS = 2.5;

const note = (freq: number, start: number, duration: number, wave: PresetWave, gain: number, attack = 0.006): PresetNote =>
  ({ freq, start, duration, wave, gain, attack });

export const SOUND_PRESETS: readonly SoundPreset[] = [
  {
    id: 'ding-dong', label: 'Ding-dong',
    notes: [
      note(659.25, 0, 0.9, 'sine', 0.42), note(1318.5, 0, 0.45, 'sine', 0.1),
      note(523.25, 0.3, 1.1, 'sine', 0.42), note(1046.5, 0.3, 0.55, 'sine', 0.1),
    ],
  },
  {
    id: 'chime', label: 'Dzwonki',
    notes: [
      note(783.99, 0, 0.5, 'sine', 0.34), note(987.77, 0.13, 0.5, 'sine', 0.34), note(1174.66, 0.26, 0.9, 'sine', 0.34),
      note(2349.3, 0.26, 0.4, 'sine', 0.06),
    ],
  },
  {
    id: 'soft-bell', label: 'Miękki dzwonek',
    notes: [note(880, 0, 1.6, 'sine', 0.4, 0.01), note(2112, 0, 0.7, 'sine', 0.07, 0.01), note(1320, 0, 0.9, 'sine', 0.08, 0.01)],
  },
  {
    id: 'marimba', label: 'Marimba',
    notes: [
      note(523.25, 0, 0.35, 'sine', 0.5, 0.003), note(2093, 0, 0.08, 'sine', 0.1, 0.002),
      note(659.25, 0.14, 0.35, 'sine', 0.5, 0.003), note(2637, 0.14, 0.08, 'sine', 0.1, 0.002),
      note(783.99, 0.28, 0.5, 'sine', 0.5, 0.003), note(3136, 0.28, 0.08, 'sine', 0.1, 0.002),
    ],
  },
  {
    id: 'pluck', label: 'Szarpnięcie',
    notes: [note(440, 0, 0.3, 'triangle', 0.5, 0.003), note(659.25, 0.11, 0.4, 'triangle', 0.5, 0.003)],
  },
  {
    id: 'retro', label: 'Retro',
    notes: [note(880, 0, 0.09, 'square', 0.24, 0.002), note(1108.7, 0.11, 0.09, 'square', 0.24, 0.002), note(1318.5, 0.22, 0.16, 'square', 0.24, 0.002)],
  },
  {
    id: 'alert', label: 'Alarm',
    notes: [
      note(659.25, 0, 0.25, 'triangle', 0.5), note(880, 0.22, 0.55, 'triangle', 0.5),
      note(1318.5, 0.22, 0.3, 'sine', 0.08),
    ],
  },
  {
    id: 'low-warn', label: 'Niski sygnał ostrzegawczy',
    notes: [
      note(220, 0, 0.4, 'triangle', 0.55, 0.01), note(440, 0, 0.2, 'sine', 0.08, 0.01),
      note(164.81, 0.32, 0.8, 'triangle', 0.55, 0.01), note(329.6, 0.32, 0.3, 'sine', 0.08, 0.01),
    ],
  },
];

export const PRESET_IDS: readonly PresetId[] = SOUND_PRESETS.map((preset) => preset.id);

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value);
}

export function getPreset(id: string): SoundPreset | undefined {
  return SOUND_PRESETS.find((preset) => preset.id === id);
}

/** Length of the sound including the fade-out of the last note, in seconds. */
export function presetLength(preset: SoundPreset): number {
  return Math.max(0, ...preset.notes.map((n) => n.start + n.duration));
}

/** Envelope of one note at time `t` (seconds from the start of the sound): linear fade-in, then exponential decay to near silence. */
export function noteGainAt(n: PresetNote, t: number): number {
  const local = t - n.start;
  if (local < 0 || local > n.duration) return 0;
  if (local < n.attack) return n.gain * (local / n.attack);
  const floor = 0.0001;
  return n.gain * Math.pow(floor / n.gain, (local - n.attack) / Math.max(1e-6, n.duration - n.attack));
}

/** Highest summed envelope of the whole preset (sampled every 5 ms); stays at or below 1 so the master volume never clips. */
export function presetPeak(preset: SoundPreset): number {
  let peak = 0;
  for (let t = 0; t <= presetLength(preset); t += 0.005) {
    peak = Math.max(peak, preset.notes.reduce((sum, n) => sum + noteGainAt(n, t), 0));
  }
  return peak;
}
