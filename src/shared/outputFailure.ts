// Conservative detector of a failed Codex turn in NEW terminal output. Codex prints its errors as a red "■ <message>" history
// line; a turn that ends this way fires neither `notify` nor any hook, so the output is the only signal there is.
// A hit needs a screen LINE that starts with that bullet (after ANSI codes and leading blanks) and whose message opens with
// the exact words of a known error: a line that merely contains the text (grep results, diffs, listings, source files, an
// answer that quotes the message) never counts.

export type OutputFailure = 'usage-limit';

const BULLETS = ['■', '\u{1f590}'];
const chars = (...codes: number[]): string => codes.map((c) => String.fromCharCode(c)).join('');
const ZERO_WIDTH = new RegExp(`[${chars(0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff)}]`, 'g');
const APOSTROPHES = new RegExp(`['\`${chars(0x2018, 0x2019, 0x2bc, 0xb4)}]`, 'g');
const CONTROLS = /[\x00-\x1f\x7f]/g;
/** Escape sequences and line breaks, one match each; group 2 is the final byte of a CSI sequence. */
const TOKENS = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x1b.|\r\n|[\r\n]/g;
/** Cursor positioning, erasing and scrolling: what follows starts a new screen line. */
const LINE_BREAKING_CSI = new Set(['H', 'f', 'A', 'B', 'E', 'F', 'G', 'd', 'J', 'K', 'S', 'T', 'r', 'L', 'M']);
const LIMIT_SEGMENTS = 512;
const WRAP_LINES = 3;
const CHUNK_LIMIT = 64 * 1024;

/** Opening words of the known messages with whitespace and apostrophes removed (matching is on that normal form). */
const MESSAGES: Array<{ failure: OutputFailure; start: string }> = [
  { failure: 'usage-limit', start: 'youvehityourusagelimit' },
  { failure: 'usage-limit', start: 'quotaexceeded.checkyourplanandbillingdetails' },
];

function squash(text: string): string {
  return text.replace(CONTROLS, '').replace(/\s/g, '').replace(ZERO_WIDTH, '').replace(APOSTROPHES, '').toLowerCase();
}

/** Normal form of a whole chunk (escapes, whitespace and apostrophes removed); exported for tests. */
export function normalizeOutput(chunk: string): string {
  return squash(chunk.replace(TOKENS, ''));
}

/** Feed it the live output of one Codex cell (never a replay); it keeps the unfinished line and a wrapped message together. */
export class FailureScanner {
  /** The screen line being drawn. */
  private line = '';
  /** A bullet line seen so far plus the lines wrapped under it (normal form), or null. */
  private open: string | null = null;
  private openLines = 0;

  feed(chunk: string): OutputFailure | null {
    let found: OutputFailure | null = null;
    let last = 0;
    const text = chunk.slice(-CHUNK_LIMIT);
    const take = (text: string) => { this.line = (this.line + text).slice(-LIMIT_SEGMENTS); };
    const finish = () => {
      const hit = this.endLine();
      if (hit) found = found ?? hit;
    };
    for (const m of text.matchAll(TOKENS)) {
      take(text.slice(last, m.index));
      last = (m.index ?? 0) + m[0].length;
      if (m[2] !== undefined) {
        if (m[2] === 'C') take(' '); // cursor forward stands for blanks
        else if (LINE_BREAKING_CSI.has(m[2])) finish();
      } else if (m[0] === '\r' || m[0] === '\n' || m[0] === '\r\n') finish();
    }
    take(text.slice(last));
    // The unfinished line may already be the whole message (Codex ends it with a newline we have not seen yet).
    const hit = this.peek();
    if (hit) { found = found ?? hit; this.line = ''; this.open = null; }
    return found;
  }

  reset(): void {
    this.line = '';
    this.open = null;
    this.openLines = 0;
  }

  private bulletRest(): string | null {
    const trimmed = this.line.replace(CONTROLS, '').replace(/^\s+/, '');
    const bullet = BULLETS.find((b) => trimmed.startsWith(b));
    return bullet ? squash(trimmed.slice(bullet.length)) : null;
  }

  private match(rest: string): OutputFailure | null {
    for (const { failure, start } of MESSAGES) if (rest.startsWith(start)) return failure;
    return null;
  }

  private peek(): OutputFailure | null {
    const rest = this.bulletRest();
    if (rest !== null) return this.match(rest);
    return this.open !== null ? this.match(this.open + squash(this.line)) : null;
  }

  /** A screen line is complete: a bullet line opens a candidate, the next few lines may still be its wrapped continuation. */
  private endLine(): OutputFailure | null {
    const rest = this.bulletRest();
    const plain = squash(this.line);
    this.line = '';
    if (rest !== null) {
      this.open = rest;
      this.openLines = 1;
      return this.match(rest);
    }
    if (this.open === null || plain === '') return null;
    this.open += plain;
    if (++this.openLines > WRAP_LINES) { this.open = null; return null; }
    const hit = this.match(this.open);
    if (hit) this.open = null;
    return hit;
  }
}
