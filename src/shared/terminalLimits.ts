// Memory bounds of the terminal output path. Everything that buffers terminal output is capped by one of these constants;
// change them here, nowhere else. Rough cost per live terminal (120 columns): scrollback lines x 120 x 12 bytes in the
// renderer (xterm keeps 3 x 32 bits per cell, lines are allocated only once they exist), plus the two caps below as
// strings (one byte per character for plain output).

/** Lines of history kept by each terminal in the renderer (xterm `scrollback`). Full buffer = about 14 MB at 120 columns. */
export const SCROLLBACK_LINES = 10_000;

/** Characters of recent output the pty host keeps per terminal to replay into a reloaded renderer. */
export const PTY_REPLAY_CHARS = 512 * 1024;

/** Characters of output the renderer queues for a terminal that has no xterm instance yet (the newest ones are kept). */
export const PENDING_OUTPUT_CHARS = 512 * 1024;

/**
 * WebGL renderers alive at the same time. Chromium allows about 16 contexts per renderer process and silently drops the
 * oldest beyond that. Terminals without a context use xterm's DOM renderer. Parked (not displayed) terminals may keep
 * theirs so that switching back to a grid is instant; the least recently shown one is released first.
 */
export const MAX_WEBGL_CONTEXTS = 12;
