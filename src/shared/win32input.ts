// win32-input-mode (DECSET ?9001) encoder, as implemented by Windows Terminal.
// ConPTY requests it on startup; while active, every keydown AND keyup is sent as
//   ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
// so console apps (e.g. crossterm-based Codex) receive real key-release events — this is
// what makes "hold Space to talk" work.

export interface KeyLike {
  type: string;
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?(key: string): boolean;
}

const E = 0x100; // ENHANCED_KEY marker inside the scan-code column below

// KeyboardEvent.code -> [virtual-key code, scan code | E]
const KEYS: Record<string, [number, number]> = {
  Escape: [0x1b, 0x01], Backspace: [0x08, 0x0e], Tab: [0x09, 0x0f], Enter: [0x0d, 0x1c],
  Space: [0x20, 0x39], CapsLock: [0x14, 0x3a],
  ShiftLeft: [0x10, 0x2a], ShiftRight: [0x10, 0x36],
  ControlLeft: [0x11, 0x1d], ControlRight: [0x11, 0x1d | E],
  AltLeft: [0x12, 0x38], AltRight: [0x12, 0x38 | E],
  MetaLeft: [0x5b, 0x5b | E], MetaRight: [0x5c, 0x5c | E], ContextMenu: [0x5d, 0x5d | E],
  Minus: [0xbd, 0x0c], Equal: [0xbb, 0x0d], BracketLeft: [0xdb, 0x1a], BracketRight: [0xdd, 0x1b],
  Semicolon: [0xba, 0x27], Quote: [0xde, 0x28], Backquote: [0xc0, 0x29], Backslash: [0xdc, 0x2b],
  Comma: [0xbc, 0x33], Period: [0xbe, 0x34], Slash: [0xbf, 0x35], IntlBackslash: [0xe2, 0x56],
  Insert: [0x2d, 0x52 | E], Delete: [0x2e, 0x53 | E], Home: [0x24, 0x47 | E], End: [0x23, 0x4f | E],
  PageUp: [0x21, 0x49 | E], PageDown: [0x22, 0x51 | E],
  ArrowUp: [0x26, 0x48 | E], ArrowDown: [0x28, 0x50 | E], ArrowLeft: [0x25, 0x4b | E], ArrowRight: [0x27, 0x4d | E],
  NumLock: [0x90, 0x45], ScrollLock: [0x91, 0x46], Pause: [0x13, 0x45],
  NumpadMultiply: [0x6a, 0x37], NumpadSubtract: [0x6d, 0x4a], NumpadAdd: [0x6b, 0x4e],
  NumpadDecimal: [0x6e, 0x53], NumpadDivide: [0x6f, 0x35 | E], NumpadEnter: [0x0d, 0x1c | E],
};
'QWERTYUIOP'.split('').forEach((c, i) => (KEYS['Key' + c] = [c.charCodeAt(0), 0x10 + i]));
'ASDFGHJKL'.split('').forEach((c, i) => (KEYS['Key' + c] = [c.charCodeAt(0), 0x1e + i]));
'ZXCVBNM'.split('').forEach((c, i) => (KEYS['Key' + c] = [c.charCodeAt(0), 0x2c + i]));
'1234567890'.split('').forEach((c, i) => (KEYS['Digit' + c] = [c.charCodeAt(0), 0x02 + i]));
for (let i = 1; i <= 12; i++) KEYS['F' + i] = [0x6f + i, i <= 10 ? 0x3a + i : 0x56 + (i - 10)];
const NUMPAD_SC = [0x52, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d, 0x47, 0x48, 0x49];
for (let i = 0; i <= 9; i++) KEYS['Numpad' + i] = [0x60 + i, NUMPAD_SC[i]];

const SPECIAL_CHARS: Record<string, number> = { Enter: 13, NumpadEnter: 13, Tab: 9, Backspace: 8, Escape: 27 };

const mod = (ev: KeyLike, k: string) => ev.getModifierState?.(k) ?? false;

function controlState(ev: KeyLike, enhanced: boolean): number {
  let cs = 0;
  if (mod(ev, 'AltGraph')) cs |= 0x01 | 0x08; // RIGHT_ALT + LEFT_CTRL, like a real AltGr on Windows
  else {
    if (ev.altKey) cs |= ev.code === 'AltRight' ? 0x01 : 0x02;
    if (ev.ctrlKey) cs |= ev.code === 'ControlRight' ? 0x04 : 0x08;
  }
  if (ev.shiftKey) cs |= 0x10;
  if (mod(ev, 'NumLock')) cs |= 0x20;
  if (mod(ev, 'ScrollLock')) cs |= 0x40;
  if (mod(ev, 'CapsLock')) cs |= 0x80;
  if (enhanced) cs |= 0x100;
  return cs;
}

function unicodeChar(ev: KeyLike): number {
  if (ev.code in SPECIAL_CHARS) return SPECIAL_CHARS[ev.code];
  const k = ev.key;
  if (!k || k.length !== 1) return 0; // named keys and non-BMP characters
  if (ev.ctrlKey && !mod(ev, 'AltGraph')) {
    const u = k.toUpperCase().charCodeAt(0);
    if (u >= 64 && u <= 95) return u - 64; // Ctrl+A..Z, Ctrl+[ \ ] ^ _
    if (k === ' ' || k === '2') return 0;
  }
  return k.charCodeAt(0);
}

/** Sequence for a keydown/keyup, or null when the physical key is unknown (let xterm handle it). */
export function encodeWin32Key(ev: KeyLike): string | null {
  const entry = KEYS[ev.code];
  if (!entry) return null;
  const [vk, scRaw] = entry;
  const down = ev.type === 'keydown' ? 1 : 0;
  return `\x1b[${vk};${scRaw & 0xff};${unicodeChar(ev)};${down};${controlState(ev, (scRaw & E) !== 0)};1_`;
}
