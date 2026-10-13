import { applyStateChange, type StateChange } from './statePatch';
import { mergeStateEdit, type StateEdit, type StateSnapshot } from './stateEdits';
import type { AppState } from './types';

/** Retain unacknowledged local edits while applying authoritative MCP/main updates. */
export class OptimisticState {
  private pending: StateEdit[] = [];
  constructor(private confirmed: StateSnapshot) {}
  stage(edit: StateEdit): void { this.pending.push(edit); }
  accept(snapshot: StateSnapshot): AppState {
    if (snapshot.editId) this.pending = this.pending.filter((edit) => edit.id !== snapshot.editId);
    if (snapshot.revision >= this.confirmed.revision) this.confirmed = snapshot;
    return this.current();
  }
  /** Takes a patch of main's state; null when it does not follow the confirmed revision (ask for a full snapshot, then `accept` it). */
  acceptChange(change: StateChange): AppState | null {
    const next = applyStateChange(this.confirmed, change);
    if (!next) return null;
    return this.accept(next);
  }
  isPending(editId: string): boolean { return this.pending.some((edit) => edit.id === editId); }
  reject(editId: string): AppState {
    this.pending = this.pending.filter((edit) => edit.id !== editId);
    return this.current();
  }
  private current(): AppState { return this.pending.reduce((state, edit) => mergeStateEdit(state, edit), this.confirmed.state); }
}
