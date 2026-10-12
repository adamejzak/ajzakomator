// Plays alert sounds. Presets are synthesized with WebAudio from the data in shared/soundPresets; the system sound is a
// main-process beep; an own file is read by main (extension and size checked, only the saved path of the event),
// decoded here (no file:// access, no CSP media-src needed).
import type { AlertEventId, SoundChoice } from '../../shared/alerts';
import { getPreset, type SoundPreset } from '../../shared/soundPresets';
import { getS } from './store';

let context: AudioContext | null = null;
const cached = new Map<AlertEventId, { key: string; buffer: AudioBuffer }>();

async function audio(): Promise<AudioContext> {
  context ??= new AudioContext();
  if (context.state === 'suspended') await context.resume();
  return context;
}

async function fileBuffer(event: AlertEventId): Promise<AudioBuffer | null> {
  const loaded = await window.mc.loadAlertSound(event, cached.get(event)?.key);
  if (!loaded.ok) return null;
  if (!loaded.data) return cached.get(event)?.buffer ?? null;
  const ctx = await audio();
  const bytes = loaded.data.buffer.slice(loaded.data.byteOffset, loaded.data.byteOffset + loaded.data.byteLength) as ArrayBuffer;
  const buffer = await ctx.decodeAudioData(bytes);
  cached.set(event, { key: loaded.key, buffer });
  return buffer;
}

function playPreset(ctx: AudioContext, preset: SoundPreset, volume: number): void {
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  for (const note of preset.notes) {
    const start = t0 + note.start;
    const end = start + note.duration;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = note.wave;
    osc.frequency.value = note.freq;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(note.gain, start + note.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env).connect(master);
    osc.start(start);
    osc.stop(end + 0.05);
  }
}

/**
 * Plays one sound choice at the saved volume. Returns false when an own file was chosen but could not be played
 * (the system sound is used instead). `event` selects which saved file is read for `kind: 'file'`.
 */
export async function playAlertSound(event: AlertEventId, choice: SoundChoice, volume = getS().settings.alerts.volume): Promise<boolean> {
  if (choice.kind === 'off') return true;
  if (choice.kind === 'system') {
    window.mc.systemBeep();
    return true;
  }
  if (choice.kind === 'preset') {
    const preset = getPreset(choice.id);
    if (!preset) return true;
    try {
      playPreset(await audio(), preset, volume);
      return true;
    } catch {
      window.mc.systemBeep();
      return false;
    }
  }
  try {
    const buffer = await fileBuffer(event);
    if (buffer) {
      const ctx = await audio();
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.buffer = buffer;
      source.connect(gain).connect(ctx.destination);
      source.start();
      return true;
    }
  } catch { /* undecodable file: fall back below */ }
  cached.delete(event);
  window.mc.systemBeep();
  return false;
}
