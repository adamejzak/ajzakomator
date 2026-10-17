// A copied private key does not stay in the clipboard (0.9.2): after CLIPBOARD_CLEAR_MS the clipboard is emptied if it still
// holds that text. Only a SHA-256 of the copied text is kept while waiting, never a second plaintext copy. No DOM imports
// (the deps are injected), so it is tested in Node.

export const CLIPBOARD_CLEAR_MS = 60_000;

export interface SecretClipboardDeps {
  read(): Promise<string>;
  write(text: string): void;
  digest(text: string): Promise<string>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export function createSecretClipboard(deps: SecretClipboardDeps): { copy(text: string): Promise<void> } {
  let pending: unknown = null;
  return {
    async copy(text) {
      const copied = await deps.digest(text);
      deps.write(text);
      // A newer copy restarts the wait; the older text is no longer in the clipboard anyway.
      if (pending !== null) deps.clearTimer(pending);
      pending = deps.setTimer(() => {
        pending = null;
        void deps.read().then(async (current) => { if (current && (await deps.digest(current)) === copied) deps.write(''); }).catch(() => undefined);
      }, CLIPBOARD_CLEAR_MS);
    },
  };
}
