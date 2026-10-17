// The renderer instance of the clearing clipboard for copied private keys (src/shared/sshClipboard.ts).
import { createSecretClipboard } from '../../../../shared/sshClipboard';

const sha256 = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');

/** The app's clipboard (owned by main) with the one-minute clearing. */
export const secretClipboard = createSecretClipboard({
  read: () => window.mc.clipboardRead(),
  write: (text) => window.mc.clipboardWrite(text),
  digest: sha256,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
