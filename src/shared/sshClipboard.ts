// A copied private key does not stay in the clipboard (0.9.2): after CLIPBOARD_CLEAR_MS the clipboard is emptied if it still
// holds that text. Since 0.9.3 this runs in the main process, so reloading the window or quitting within the minute still
// clears it (`flush` on quit). Only a SHA-256 of the copied text is kept while waiting, never a second plaintext copy. No
// Electron imports (the deps are injected), so it is tested in Node.

export const CLIPBOARD_CLEAR_MS = 60_000;

export interface SecretClipboardDeps {
  read(): Promise<string>;
  write(text: string): Promise<void> | void;
  digest(text: string): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface SecretClipboard {
  /** Writes the text and starts (or restarts) the wait; rejects when the clipboard could not be written. */
  copy(text: string): Promise<void>;
  /** Whether a copied text still waits to be cleared. */
  pending(): boolean;
  /** Clears now if the clipboard still holds the copied text (the app quits); nothing waits afterwards. */
  flush(): Promise<void>;
}

export function createSecretClipboard(deps: SecretClipboardDeps): SecretClipboard {
  let waiting: { timer: unknown; digest: string } | null = null;
  let clearing: Promise<void> | null = null;
  const clearIfStill = async (digest: string) => {
    try {
      const current = await deps.read();
      if (current && deps.digest(current) === digest) await deps.write('');
    } catch { /* the clipboard is not readable: nothing to compare */ }
  };
  return {
    async copy(text) {
      const digest = deps.digest(text);
      await deps.write(text);
      // A newer copy restarts the wait; the older text is no longer in the clipboard anyway.
      if (waiting) deps.clearTimer(waiting.timer);
      const timer = deps.setTimer(() => {
        if (waiting?.timer !== timer) return;
        waiting = null;
        void clearIfStill(digest);
      }, CLIPBOARD_CLEAR_MS);
      waiting = { timer, digest };
    },
    pending: () => waiting !== null || clearing !== null,
    flush() {
      if (waiting) {
        const { timer, digest } = waiting;
        waiting = null;
        deps.clearTimer(timer);
        // Still pending while the clipboard is read and cleared, so a quit right after waits for it.
        const run: Promise<void> = clearIfStill(digest).finally(() => { if (clearing === run) clearing = null; });
        clearing = run;
      }
      return clearing ?? Promise.resolve();
    },
  };
}
