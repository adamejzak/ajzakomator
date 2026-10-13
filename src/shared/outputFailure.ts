// Conservative detector of a failed Codex turn in NEW terminal output. Codex prints its errors as a red "■ <message>" history
// line; a turn that ends this way fires neither `notify` nor any hook, so the output is the only signal there is.
// The marker plus the exact opening of the known messages are required, so an agent that merely mentions the phrase in its
// answer (which starts with "•", never "■") does not count.

export type OutputFailure = 'usage-limit';

// CSI, OSC (BEL or ST terminated), and any other two-character escape.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b./g;
// Whitespace, controls and zero-width / hair spaces: cursor-addressed redraws drop or move spaces, so words may touch.
const chars = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join('');
// JS \s already covers the no-break, hair and line-separator spaces; the zero-width ones are added.
const CONTROLS = /[\x00-\x1f\x7f]/g;
const ZERO_WIDTH = new RegExp(`[${chars(0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060)}]`, 'g');
const APOSTROPHES = new RegExp(`['\`${chars(0x2018, 0x2019, 0x2bc, 0xb4)}]`, 'g');
const TAIL_LIMIT = 192;
const CHUNK_LIMIT = 64 * 1024;

/** Marker, then the words of the message with whitespace and apostrophes removed (matching is on that normal form). */
const PATTERNS: Array<{ failure: OutputFailure; re: RegExp }> = [
  { failure: 'usage-limit', re: /[■\u{1f590}]youvehityourusagelimit/iu },
  { failure: 'usage-limit', re: /[■\u{1f590}]quotaexceeded\.?checkyourplanandbillingdetails/iu },
];

export function normalizeOutput(chunk: string): string {
  return chunk.slice(-CHUNK_LIMIT).replace(ESCAPES, '').replace(CONTROLS, '').replace(/\s/g, '').replace(ZERO_WIDTH, '').replace(APOSTROPHES, '');
}

/** Feed it the live output of one Codex cell (never a replay); it remembers a short tail so a message split over chunks is found. */
export class FailureScanner {
  private tail = '';

  feed(chunk: string): OutputFailure | null {
    const text = this.tail + normalizeOutput(chunk);
    let found: OutputFailure | null = null;
    for (const { failure, re } of PATTERNS) if (re.test(text)) { found = failure; break; }
    // After a hit the tail is dropped so the same line is not reported again by the next chunk.
    this.tail = found ? '' : text.slice(-TAIL_LIMIT);
    return found;
  }

  reset(): void {
    this.tail = '';
  }
}
