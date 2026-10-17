// Pure helpers for the pty output path: a bounded replay tail, renderer back-pressure and the coalescing delay.

/** Stored pieces of a tail before they are joined into one string. */
export const MAX_TAIL_CHUNKS = 256;

/** Keeps roughly the newest `limit` characters of a stream without re-copying the whole tail on every chunk. */
export class TailBuffer {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly limit: number) {}

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.length += data.length;
    // Drop whole leading chunks that are no longer needed; the exact cut happens in toString().
    while (this.chunks.length > 1 && this.length - this.chunks[0].length >= this.limit) {
      this.length -= this.chunks.shift()!.length;
    }
    // Many tiny chunks (echoes, spinners) cost far more as separate strings than their characters: join them now and then.
    if (this.chunks.length > MAX_TAIL_CHUNKS) this.compact();
  }

  /** Number of stored pieces (tests). */
  get pieces(): number {
    return this.chunks.length;
  }

  private compact(): void {
    const all = this.chunks.join('');
    const kept = all.length > this.limit ? all.slice(-this.limit) : all;
    this.chunks = [kept];
    this.length = kept.length;
  }

  /** The newest `limit` characters (same result as repeatedly doing `(tail + data).slice(-limit)`). */
  toString(): string {
    const all = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
    if (this.chunks.length > 1) this.chunks = [all];
    return all.length > this.limit ? all.slice(-this.limit) : all;
  }
}

/** Bytes the renderer may be behind before the pty is paused, and the level at which it is resumed. */
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;

/** Counts characters sent to the renderer but not yet parsed there (acknowledged). */
export class FlowGate {
  private pending = 0;
  paused = false;

  /** Characters sent but not acknowledged yet. */
  get inFlight(): number {
    return this.pending;
  }

  /** Returns true when the pty has to be paused now. */
  sent(n: number): boolean {
    this.pending += n;
    if (!this.paused && this.pending >= HIGH_WATER) {
      this.paused = true;
      return true;
    }
    return false;
  }

  /** Returns true when the pty may be resumed now. */
  acked(n: number): boolean {
    this.pending = Math.max(0, this.pending - n);
    if (this.paused && this.pending <= LOW_WATER) {
      this.paused = false;
      return true;
    }
    return false;
  }

  /** Lifts a pause without forgetting what is in flight (the renderer is slow, not gone). */
  release(): void {
    this.paused = false;
  }

  /** Forgets everything in flight (renderer reconnected). Returns true when a pause has to be lifted. */
  reset(): boolean {
    const wasPaused = this.paused;
    this.pending = 0;
    this.paused = false;
    return wasPaused;
  }
}

/** Typing echoes must stay snappy; bulk output is coalesced into roughly one frame. */
export const ECHO_COALESCE_MS = 4;
export const BULK_COALESCE_MS = 12;
/** A buffer this large is sent at once instead of waiting for the timer. */
export const FLUSH_NOW_CHARS = 128 * 1024;
const ECHO_WINDOW_MS = 150;

export function coalesceDelay(now: number, lastWrite: number): number {
  return now - lastWrite < ECHO_WINDOW_MS ? ECHO_COALESCE_MS : BULK_COALESCE_MS;
}

/**
 * The bulk delay moved onto a shared BULK_COALESCE_MS grid (between half and one and a half periods, one period on average),
 * so busy terminals flush in the same timer turn and their output leaves the host as one message.
 */
export function alignedDelay(now: number, delay: number): number {
  if (delay !== BULK_COALESCE_MS) return delay;
  const next = BULK_COALESCE_MS - (now % BULK_COALESCE_MS);
  return next < BULK_COALESCE_MS / 2 ? next + BULK_COALESCE_MS : next;
}
