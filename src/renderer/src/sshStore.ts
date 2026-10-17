// Renderer SSH state (R1): vault info, session states and open prompts per cell, the SSH view (W3). No imports of actions, files or terminals.
import { create } from 'zustand';
import { applySshSnapshot, type SshPrompt, type SshSessionState, type SshSessionsSnapshot, type SshVaultInfo } from '../../shared/ssh';
import { DEFAULT_SSH_SECTION, type SshDetail, type SshSection } from '../../shared/sshView';

interface SshStore {
  vault: SshVaultInfo | null;
  sessions: Record<string, SshSessionState>;
  prompts: Record<string, SshPrompt>;
  /** The SSH workspace tab exists (W3); it stays mounted while open, also when another tab is in front. */
  viewOpen: boolean;
  /** The SSH view is the workspace on screen (Settings still wins, see activeWorkspaceKey). */
  viewActive: boolean;
  /** What its details pane shows. */
  detail: SshDetail | null;
  /** Ctrl/Cmd+click selection of host tiles. */
  selectedHosts: string[];
  /** The section of the view chosen in the SSH mode navigation (kept for this app session, like the other UI state). */
  section: SshSection;
  setVault(vault: SshVaultInfo): void;
  setSession(state: SshSessionState): void;
  setPrompt(cellId: string, prompt: SshPrompt | null): void;
  load(vault: SshVaultInfo, snapshot: SshSessionsSnapshot): void;
  forgetCell(cellId: string): void;
}

export const useSshStore = create<SshStore>((set) => ({
  vault: null, sessions: {}, prompts: {}, viewOpen: false, viewActive: false, detail: null, selectedHosts: [], section: DEFAULT_SSH_SECTION,
  setVault: (vault) => set({ vault }),
  setSession: (state) => set((st) => ({ sessions: { ...st.sessions, [state.cellId]: state } })),
  setPrompt: (cellId, prompt) => set((st) => {
    const { [cellId]: _old, ...rest } = st.prompts;
    return { prompts: prompt ? { ...rest, [cellId]: prompt } : rest };
  }),
  load: (vault, snapshot) => set({ vault, ...applySshSnapshot(snapshot) }),
  forgetCell: (cellId) => set((st) => {
    const { [cellId]: _s, ...sessions } = st.sessions;
    const { [cellId]: _p, ...prompts } = st.prompts;
    return { sessions, prompts };
  }),
}));

/**
 * M7: events that arrive while the first snapshot is being fetched are held and applied after load(), in order, so a newer
 * session or prompt event is never overwritten by the older snapshot. `wrap` the handlers, call `open` after load().
 */
export function createInitGate(): { wrap<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void; open(): void } {
  let held: Array<() => void> | null = [];
  return {
    wrap: (fn) => (...args) => { if (held) held.push(() => fn(...args)); else fn(...args); },
    open: () => { const queue = held ?? []; held = null; for (const run of queue) run(); },
  };
}
