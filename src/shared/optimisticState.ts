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
  reject(editId: string): AppState {
    this.pending = this.pending.filter((edit) => edit.id !== editId);
    return this.current();
  }
  private current(): AppState { return this.pending.reduce((state, edit) => mergeStateEdit(state, edit), this.confirmed.state); }
}
