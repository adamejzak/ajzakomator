import { create } from 'zustand';
import { defaultState } from '../../shared/state';
import type { CellStatus } from '../../shared/status';
import type { AppState } from '../../shared/types';
import { OptimisticState } from '../../shared/optimisticState';
import type { StateSnapshot } from '../../shared/stateEdits';
import type { McpInfo } from '../../shared/automation';

export type Modal =
  | { kind: 'grid'; projectId: string }
  | { kind: 'history'; projectId: string }
  | { kind: 'settings' }
  | { kind: 'snippet'; snippetId: string | null; projectId?: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'file'; projectId: string; relativePath: string };

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
  sidebarView: 'projects' | 'files';
  automationOpen: boolean;
  mcpInfo: McpInfo;
}

interface Store {
  s: AppState;
  ui: Ui;
  ready: boolean;
  update(fn: (s: AppState) => AppState): void;
  setUi(patch: Partial<Ui> | ((ui: Ui) => Partial<Ui>)): void;
  init(snapshot: StateSnapshot): void;
  sync(snapshot: StateSnapshot): void;
}

const optimistic = new OptimisticState({ state: defaultState(window.mc.platform), revision: -1 });

export const useStore = create<Store>((set, get) => ({
  s: defaultState(window.mc.platform),
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
    sidebarView: 'projects',
    automationOpen: false,
    mcpInfo: { running: false },
  },
  ready: false,
  update(fn) {
    const base = get().s;
    const next = fn(base);
    if (next === base) return;
    const edit = { id: crypto.randomUUID(), base, next };
    optimistic.stage(edit);
    set({ s: next });
    void window.mc.applyStateEdit(edit).then((snapshot) => get().sync(snapshot)).catch((error) => {
      set({ s: optimistic.reject(edit.id) });
      toast(String(error), 'error');
    });
  },
  setUi(patch) {
    set((st) => ({ ui: { ...st.ui, ...(typeof patch === 'function' ? patch(st.ui) : patch) } }));
  },
  init(snapshot) {
    set({ s: optimistic.accept(snapshot), ready: true });
  },
  sync(snapshot) { set({ s: optimistic.accept(snapshot) }); },
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
