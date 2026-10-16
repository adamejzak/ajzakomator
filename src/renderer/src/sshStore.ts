// Renderer SSH state (R1): vault info, session states and open prompts per cell, editor tabs. No imports of actions, files or terminals.
import { create } from 'zustand';
import { applySshSnapshot, type SshPrompt, type SshSessionState, type SshSessionsSnapshot, type SshVaultInfo } from '../../shared/ssh';

export interface SshEditorTab { id: string; kind: 'host' | 'key' | 'newKey'; targetId?: string }

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
