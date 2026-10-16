// Renderer SSH state (R1): vault info, session states and open prompts per cell, editor tabs. No imports of actions, files or terminals.
import { create } from 'zustand';
import { applySshSnapshot, type SshEditorRef, type SshPrompt, type SshSessionState, type SshSessionsSnapshot, type SshVaultInfo } from '../../shared/ssh';

export type SshEditorTab = SshEditorRef;

interface SshStore {
  vault: SshVaultInfo | null;
  sessions: Record<string, SshSessionState>;
  prompts: Record<string, SshPrompt>;
  editors: SshEditorTab[];
  activeEditorId: string | null;
  /** Ctrl/Cmd+click selection in the host list (Task 9). */
  selectedHosts: string[];
  setVault(vault: SshVaultInfo): void;
  setSession(state: SshSessionState): void;
  setPrompt(cellId: string, prompt: SshPrompt | null): void;
  load(vault: SshVaultInfo, snapshot: SshSessionsSnapshot): void;
  forgetCell(cellId: string): void;
}

export const useSshStore = create<SshStore>((set) => ({
  vault: null, sessions: {}, prompts: {}, editors: [], activeEditorId: null, selectedHosts: [],
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
