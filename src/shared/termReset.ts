// Terminal input modes (mouse / focus / bracketed paste / kitty keyboard) are switched on by the agent CLI with DEC private
// modes and are the CLI's to switch off again. A CLI that dies hard (crash, kill) never does, so the terminal keeps sending
// mouse and focus reports to whatever runs next - the shell prompt then prints them as `[<35;77;38M` garbage.
// These helpers build the reset that is typed after the CLI command (it runs when the CLI returns, however it ended),
// the same reset for the terminal emulator itself, and the guard that stops a mouse-report flood into a shell.

import type { ShellKind } from './types';

/**
 * 1000/1002/1003 mouse tracking, 1005/1006/1015 mouse encodings, 1004 focus reports, 2004 bracketed paste.
 * 9001 (win32-input-mode) is deliberately absent: ConPTY switches it on once at startup and owns it, so clearing it would
 * cost every later program in that shell the key-release events.
 */
export const INPUT_MODE_PARAMS = [1000, 1002, 1003, 1005, 1006, 1015, 1004, 2004] as const;

/** Mode reset plus "pop one level of kitty keyboard flags". Only CSI sequences: safe to write to a terminal at any time. */
export const INPUT_MODES_OFF = `\x1b[?${INPUT_MODE_PARAMS.join(';')}l\x1b[<u`;

/**
 * Full mode reset of the terminal emulator for the manual "reset terminal" action: input modes, application cursor keys and
 * keypad, visible cursor, default attributes. Never touches the buffer, so scrollback survives. `inAlternateScreen` adds the
 * leave-alternate-screen request (only then: DECRC of an unmatched save would move the cursor).
 */
export function terminalModeReset(inAlternateScreen: boolean): string {
  return `${INPUT_MODES_OFF}\x1b[?1l\x1b>\x1b[?25h\x1b[0m${inAlternateScreen ? '\x1b[?1049l' : ''}`;
}

const PS_ESC = `[char]27+'[?${INPUT_MODE_PARAMS.join(';')}l'+[char]27+'[<u'`;

/**
 * Appended to the typed CLI command; runs after the CLI returned. PowerShell and POSIX shells run it unconditionally with `;`,
 * cmd with `&` (cmd has no ESC literal, so a throwaway PowerShell writes it). Prints nothing visible.
 */
export function resetTail(shell: ShellKind = 'pwsh'): string {
  if (shell === 'cmd') return ` & powershell -NoProfile -NonInteractive -Command "[Console]::Write(${PS_ESC})" 2>nul`;
  if (shell === 'zsh' || shell === 'bash') return `; printf '\\033[?${INPUT_MODE_PARAMS.join(';')}l\\033[<u'`;
  return `; [Console]::Write(${PS_ESC})`;
}

/** SGR / normal / X10 mouse reports (`ESC[<Cb;Cx;CyM|m`, `ESC[M` + 3 bytes): what a terminal in mouse-tracking mode writes. */
export function isMouseReport(data: string): boolean {
  return /^\x1b\[(?:<[\d;]*[Mm]|M[\s\S]{3})$/.test(data);
}

const ECHO_RE = /\[(?:<)?\d+;\d+;\d+[Mm]/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[\d;?<>= ]*[A-Za-z]/g;

/**
 * How many printed copies of a mouse report the output holds (`^[[<35;12;6M`, or `[555;12;6M` once PSReadLine ate part of it).
 * Control sequences are stripped first, so a real escape sequence in the output never counts and syntax colouring between
 * the characters of an echo does not hide it.
 */
export function countMouseEchoes(output: string): number {
  return (output.replace(CSI_RE, '').match(ECHO_RE) ?? []).length;
}

/** More mouse reports than this per second are a flood once the status says the CLI is gone. */
export const MOUSE_FLOOD_PER_SECOND = 40;
/** Printed copies of reports within the window that prove the receiver is a shell and not a program using the mouse. */
export const MOUSE_ECHO_PROOF = 3;
/** With that proof a much lower rate already is a flood: every report is a line of garbage in the prompt. */
export const MOUSE_ECHO_FLOOD_PER_SECOND = 15;
const WINDOW_MS = 1000;
const CAP = 400;

/**
 * Stops mouse reports from flooding a shell. A TUI that tracks the mouse legitimately receives far more than 40 motion
 * reports a second, so the rate alone never trips it: it also needs proof that the CLI is gone (the cell's status says so,
 * more than 40 a second) or that the reports come back as printed text, which only a shell prompt does (more than 15 a second). Clock injected for tests.
 */
export class MouseFloodGuard {
  private sent: number[] = [];
  private echoes: number[] = [];
  tripped = false;

  /** True while recent reports make a scan of the output for echoes worthwhile (keeps the scan off the hot path). */
  watching(now: number): boolean {
    return !this.tripped && this.sent.length > 0 && now - this.sent[this.sent.length - 1] < 2 * WINDOW_MS;
  }

  /** A mouse report is about to be forwarded. Returns true when it must be dropped instead. */
  report(now: number, cliGone: boolean): boolean {
    if (this.tripped) return true;
    prune(this.sent, now);
    prune(this.echoes, now);
    if (this.sent.length < CAP) this.sent.push(now);
    const echoed = this.echoes.length >= MOUSE_ECHO_PROOF;
    if ((cliGone && this.sent.length > MOUSE_FLOOD_PER_SECOND) || (echoed && this.sent.length > MOUSE_ECHO_FLOOD_PER_SECOND)) {
      this.tripped = true;
      return true;
    }
    return false;
  }

  /** Output of the pty arrived: remember how many printed mouse reports it held. */
  output(now: number, text: string): void {
    if (!this.watching(now)) return;
    const n = countMouseEchoes(text);
    for (let i = 0; i < n && this.echoes.length < CAP; i++) this.echoes.push(now);
  }

  reset(): void {
    this.sent = [];
    this.echoes = [];
    this.tripped = false;
  }
}

function prune(list: number[], now: number): void {
  let i = 0;
  while (i < list.length && now - list[i] > WINDOW_MS) i++;
  if (i) list.splice(0, i);
}
