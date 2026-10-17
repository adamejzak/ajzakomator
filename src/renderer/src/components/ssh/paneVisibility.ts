// Whether the details pane of the SSH view is on screen. The view stays mounted while its tab is open (SshView), so a hidden
// pane would keep what was typed into it; secrets must not wait there (D4).
import { createContext, useContext, useEffect, useId, useRef } from 'react';

export const PaneActive = createContext(true);

/** Editors of the pane report unsaved changes here, so closing the pane (Esc, X, a second click) asks first. */
export const PaneDirty = createContext<(id: string, dirty: boolean) => void>(() => undefined);

/** Reports whether this editor has unsaved changes while it is mounted (cleared when it unmounts). */
export function useReportDirty(dirty: boolean): void {
  const report = useContext(PaneDirty);
  const id = useId();
  useEffect(() => { report(id, dirty); }, [report, id, dirty]);
  useEffect(() => () => report(id, false), [report, id]);
}

/** D4: when the pane goes hidden, `clear` drops typed secrets (passwords, passphrases, a pasted private key); other fields stay. */
export function useClearWhenHidden(clear: () => void): void {
  const active = useContext(PaneActive);
  const latest = useRef(clear);
  latest.current = clear;
  useEffect(() => { if (!active) latest.current(); }, [active]);
}
