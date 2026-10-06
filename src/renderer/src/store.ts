import { create } from 'zustand';
import { defaultState } from '../../shared/state';
import type { CellStatus } from '../../shared/status';
import type { AppState } from '../../shared/types';

export type Modal =
  | { kind: 'grid'; projectId: string }
  | { kind: 'history'; projectId: string }
  | { kind: 'settings' }
  | { kind: 'snippet'; snippetId: string | null }
  | { kind: 'project'; projectId: string };

export type Dialog =
  | { kind: 'prompt'; title: string; value: string; placeholder?: string; onSubmit: (value: string) => void }
  | {
      kind: 'confirm';
      title: string;
      body: string;
      actions: Array<{ label: string; value: string; danger?: boolean; primary?: boolean }>;
      onChoose: (value: string | null) => void;
    };

export interface Ui {
  statuses: Record<string, CellStatus>;
  focusedCellId: string | null;
  maximizedCellId: string | null;
  palette: boolean;
  modal: Modal | null;
  dialog: Dialog | null;
  toast: { text: string; kind: 'info' | 'error' } | null;
  cellErrors: Record<string, string>;
  missingPaths: Record<string, true>;
  /** Conversation titles by session id (from Claude/Codex transcripts) — default cell labels. */
  sessionTitles: Record<string, string>;
  /** Bumped when every terminal must be (re)started, e.g. after a pty host crash. */
  epoch: number;
}

interface Store {
  s: AppState;
  ui: Ui;
  ready: boolean;
  update(fn: (s: AppState) => AppState): void;
  setUi(patch: Partial<Ui> | ((ui: Ui) => Partial<Ui>)): void;
  init(s: AppState): void;
}

export const useStore = create<Store>((set, get) => ({
  s: defaultState(),
  ui: {
    statuses: {},
    focusedCellId: null,
    maximizedCellId: null,
    palette: false,
    modal: null,
    dialog: null,
    toast: null,
    cellErrors: {},
    missingPaths: {},
    sessionTitles: {},
    epoch: 0,
  },
  ready: false,
  update(fn) {
    const next = fn(get().s);
    if (next === get().s) return;
    set({ s: next });
    window.mc.saveState(next);
  },
  setUi(patch) {
    set((st) => ({ ui: { ...st.ui, ...(typeof patch === 'function' ? patch(st.ui) : patch) } }));
  },
  init(s) {
    set({ s, ready: true });
  },
}));

export const getS = () => useStore.getState().s;
export const getUi = () => useStore.getState().ui;
export const update = (fn: (s: AppState) => AppState) => useStore.getState().update(fn);
export const setUi = (patch: Partial<Ui> | ((ui: Ui) => Partial<Ui>)) => useStore.getState().setUi(patch);

let toastTimer: number | undefined;
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  setUi({ toast: { text, kind } });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setUi({ toast: null }), kind === 'error' ? 6000 : 3000);
}

export function askText(title: string, value = '', placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => {
    setUi({
      dialog: {
        kind: 'prompt', title, value, placeholder,
        onSubmit: (v) => {
          pendingPrompt = null;
          setUi({ dialog: null });
          resolve(v);
        },
      },
    });
    // Closing the modal without submit resolves with null (see Modals).
    pendingPrompt = () => resolve(null);
  });
}

export function askChoice(
  title: string, body: string,
  actions: Array<{ label: string; value: string; danger?: boolean; primary?: boolean }>,
): Promise<string | null> {
  return new Promise((resolve) => {
    setUi({
      dialog: {
        kind: 'confirm', title, body, actions,
        onChoose: (v) => {
          pendingPrompt = null;
          setUi({ dialog: null });
          resolve(v);
        },
      },
    });
    pendingPrompt = () => resolve(null);
  });
}

let pendingPrompt: (() => void) | null = null;
export function closeModal(): void {
  setUi({ modal: null });
}

export function closeDialog(): void {
  const p = pendingPrompt;
  pendingPrompt = null;
  setUi({ dialog: null });
  p?.();
}
