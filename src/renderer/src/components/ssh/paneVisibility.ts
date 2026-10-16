// Whether an SSH editor pane is the one on screen. Every open editor stays mounted (SshEditorScreen), so a hidden one would
// keep what was typed into it; secrets must not wait there (D4).
import { createContext, useContext, useEffect, useRef } from 'react';

export const PaneActive = createContext(true);

/** D4: when the pane goes hidden, `clear` drops typed secrets (passwords, passphrases, a pasted private key); other fields stay. */
export function useClearWhenHidden(clear: () => void): void {
  const active = useContext(PaneActive);
  const latest = useRef(clear);
  latest.current = clear;
  useEffect(() => { if (!active) latest.current(); }, [active]);
}
