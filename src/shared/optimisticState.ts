import { applyStateChange, type StateChange } from './statePatch';
import { mergeStateEdit, type StateEdit, type StateSnapshot } from './stateEdits';
import type { AppState } from './types';

/**
 * Retain unacknowledged local edits while applying authoritative MCP/main updates.
 * An edit stays pending until main's state is known to contain it: its own patch (editId), main's acknowledgement
 * (the revision it got) once the confirmed revision reaches it, or a full snapshot that was requested after it was sent.
 */
export class OptimisticState {
  private pending: StateEdit[] = [];
  /** Revision main gave an edit (from its acknowledgement), until the confirmed state reaches it. */
  private appliedAt = new Map<string, number>();
  constructor(private confirmed: StateSnapshot) {}
  get revision(): number { return this.confirmed.revision; }
  get pendingCount(): number { return this.pending.length; }
  pendingIds(): string[] { return this.pending.map((edit) => edit.id); }
  isPending(editId: string): boolean { return this.pending.some((edit) => edit.id === editId); }
  stage(edit: StateEdit): void { this.pending.push(edit); }
  accept(snapshot: StateSnapshot): AppState {
    if (snapshot.editId) this.drop([snapshot.editId]);
    if (snapshot.revision >= this.confirmed.revision) this.confirmed = snapshot;
    this.settle();
    return this.current();
  }
  /**
   * A full snapshot fetched after `covered` edits were sent: main handles messages in order, so it already contains them
   * (or rejected them, which `reject` takes care of), and they must not be applied on top of it again.
   */
  acceptSnapshot(snapshot: StateSnapshot, covered: readonly string[]): AppState {
    this.drop(covered);
    return this.accept({ state: snapshot.state, revision: snapshot.revision });
  }
  /** Takes a patch of main's state; null when it does not follow the confirmed revision (ask for a full snapshot, then `acceptSnapshot` it). */
  acceptChange(change: StateChange): AppState | null {
    const next = applyStateChange(this.confirmed, change);
    if (!next) return null;
    return this.accept(next);
  }
  /** Main acknowledged an edit with the revision it got. `behind`: the edit is still pending because the confirmed state has not reached that revision yet. */
  ack(editId: string, revision: number): { state: AppState; dropped: boolean; behind: boolean } {
    const before = this.pending.length;
    if (this.isPending(editId)) this.appliedAt.set(editId, revision);
    this.settle();
    return { state: this.current(), dropped: this.pending.length !== before, behind: this.isPending(editId) };
  }
  reject(editId: string): AppState {
    this.drop([editId]);
    return this.current();
  }
  private drop(ids: readonly string[]): void {
    if (!ids.length) return;
    const gone = new Set(ids);
    this.pending = this.pending.filter((edit) => !gone.has(edit.id));
    for (const id of gone) this.appliedAt.delete(id);
  }
  private settle(): void {
    for (const edit of [...this.pending]) {
      const at = this.appliedAt.get(edit.id);
      if (at !== undefined && at <= this.confirmed.revision) this.drop([edit.id]);
    }
  }
  private current(): AppState { return this.pending.reduce((state, edit) => mergeStateEdit(state, edit), this.confirmed.state); }
}
