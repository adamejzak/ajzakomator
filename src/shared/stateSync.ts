// The renderer's side of the state protocol: optimistic edits, acks, patches, and the full-snapshot fallback.
// Transport and timers are injected, so fault injection tests drive it against a real StateController.
import { OptimisticState } from './optimisticState';
import type { StateEdit, StateSnapshot } from './stateEdits';
import { pruneEdit, type StateAck, type StateChange } from './statePatch';
import type { AppState } from './types';

export interface SyncTransport {
  applyEdit(edit: StateEdit): Promise<StateAck>;
  loadSnapshot(): Promise<StateSnapshot>;
}

export interface SyncDeps {
  transport: SyncTransport;
  setTimer(fn: () => void, ms: number): unknown;
  /** The state to show changed. */
  onState(state: AppState): void;
  onError?(error: unknown): void;
}

/** After an ack whose revision the patches have not reached yet, wait this long for the patch before asking for a snapshot. */
export const ACK_GRACE_MS = 400;
/** A failed snapshot request is repeated after this long. */
export const RESYNC_RETRY_MS = 500;

export class StateSync {
  private readonly optimistic: OptimisticState;
  private resyncing: Promise<void> | null = null;
  private again = false;
  private buffered: StateChange[] = [];

  constructor(initial: StateSnapshot, private readonly deps: SyncDeps) {
    this.optimistic = new OptimisticState(initial);
  }

  get pendingCount(): number { return this.optimistic.pendingCount; }
  get revision(): number { return this.optimistic.revision; }
  get busy(): boolean { return this.resyncing !== null; }

  /** The first full state. */
  init(snapshot: StateSnapshot): AppState { return this.optimistic.accept(snapshot); }

  /** A local edit: the caller shows it already; it is sent pruned and stays pending until main's state is known to contain it. */
  submit(edit: StateEdit): void {
    this.optimistic.stage(edit);
    this.deps.transport.applyEdit(pruneEdit(edit)).then(
      (ack) => this.onAck(edit.id, ack),
      (error) => { this.deps.onState(this.optimistic.reject(edit.id)); this.deps.onError?.(error); },
    );
  }

  /** Main's change (a patch or a full snapshot). While a resync runs it is kept and replayed on top of the snapshot. */
  receive(change: StateChange): void {
    if (this.resyncing) { this.buffered.push(change); return; }
    const next = this.optimistic.acceptChange(change);
    if (next) this.deps.onState(next);
    else void this.resync();
  }

  /** Fetches main's full state; changes that arrive meanwhile are replayed, and a second snapshot is taken when they do not follow it. */
  resync(): Promise<void> {
    if (this.resyncing) { this.again = true; return this.resyncing; }
    this.resyncing = this.runResync().finally(() => { this.resyncing = null; });
    return this.resyncing;
  }

  private onAck(editId: string, ack: StateAck): void {
    const { state, dropped, behind } = this.optimistic.ack(editId, ack.revision);
    if (dropped) this.deps.onState(state);
    if (behind) this.deps.setTimer(() => { if (this.optimistic.isPending(editId)) void this.resync(); }, ACK_GRACE_MS);
  }

  private async runResync(): Promise<void> {
    do {
      this.again = false;
      // Edits sent before this request are in the snapshot: main handles messages in order.
      const covered = this.optimistic.pendingIds();
      let snapshot: StateSnapshot;
      try {
        snapshot = await this.deps.transport.loadSnapshot();
      } catch (error) {
        this.deps.onError?.(error);
        await new Promise<void>((resolve) => this.deps.setTimer(resolve, RESYNC_RETRY_MS));
        this.again = true;
        continue;
      }
      this.deps.onState(this.optimistic.acceptSnapshot(snapshot, covered));
      const queue = this.buffered;
      this.buffered = [];
      for (const change of queue) {
        const next = this.optimistic.acceptChange(change);
        if (next) this.deps.onState(next);
        else this.again = true;
      }
    } while (this.again);
  }
}
