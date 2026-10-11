// Plays the "cell is waiting" sound. The system sound is a main-process beep; an own file is read by
// main (size and extension checked), decoded here with WebAudio (no file:// access, no CSP media-src needed).
import { getS } from './store';

let context: AudioContext | null = null;
let cached: { key: string; buffer: AudioBuffer } | null = null;

async function customBuffer(): Promise<AudioBuffer | null> {
  const loaded = await window.mc.loadWaitingSound(cached?.key);
  if (!loaded.ok) return null;
  if (!loaded.data) return cached?.buffer ?? null;
  context ??= new AudioContext();
  const bytes = loaded.data.buffer.slice(loaded.data.byteOffset, loaded.data.byteOffset + loaded.data.byteLength) as ArrayBuffer;
  const buffer = await context.decodeAudioData(bytes);
  cached = { key: loaded.key, buffer };
  return buffer;
}

/** Plays the configured sound; returns false when an own file was chosen but could not be played (system sound is used instead). */
export async function playWaitingSound(mode = getS().settings.waitingSound): Promise<boolean> {
  if (mode === 'off') return true;
  if (mode === 'custom') {
    try {
      const buffer = await customBuffer();
      if (buffer && context) {
        if (context.state === 'suspended') await context.resume();
        const source = context.createBufferSource();
        const gain = context.createGain();
        gain.gain.value = getS().settings.waitingSoundVolume / 100;
        source.buffer = buffer;
        source.connect(gain).connect(context.destination);
        source.start();
        return true;
      }
    } catch { /* undecodable file: fall back below */ }
    cached = null;
    window.mc.systemBeep();
    return false;
  }
  window.mc.systemBeep();
  return true;
}
