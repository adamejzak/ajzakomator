import { mergeStateEdit, type StateEdit, type StateSnapshot } from '../shared/stateEdits';
import type { AppState } from '../shared/types';
import { layoutForCount, MAX_CELLS } from '../shared/layout';

/** Main is the single writer. Renderer edits rebase; MCP operations mutate the latest state. */
export class StateController {
  private revision = 0;
  constructor(private state: AppState, private readonly changed: (snapshot: StateSnapshot) => void) {}
  get(): AppState { return this.state; }
  snapshot(): StateSnapshot { return { state: this.state, revision: this.revision }; }
  change(fn: (state: AppState) => AppState, editId?: string): StateSnapshot {
    this.state = fn(this.state);
    const snapshot = { state: this.state, revision: ++this.revision, editId };
    this.changed(snapshot);
    return snapshot;
  }
  apply(edit: StateEdit): StateSnapshot {
    return this.change((state) => {
      const next = mergeStateEdit(state, edit);
      return { ...next, projects: next.projects.map((project) => ({ ...project,
        tabs: project.tabs.map((tab) => {
          if (tab.cells.length < 1 || tab.cells.length > MAX_CELLS) throw new Error('Concurrent grid change exceeds the cell limit.');
          return tab.layout.areas.length === tab.cells.length ? tab : { ...tab, layout: layoutForCount(tab.cells.length) };
        }),
      })) };
    }, edit.id);
  }
}
