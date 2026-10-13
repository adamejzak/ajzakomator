import { mergeStateEdit, type StateEdit, type StateSnapshot } from '../shared/stateEdits';
import type { AppState } from '../shared/types';
import { layoutForCount, MAX_CELLS } from '../shared/layout';
import { normalizeAlerts } from '../shared/alerts';

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
      // The renderer cannot store arbitrary alert values (unknown presets, relative or UNC sound paths): they are normalized here.
      return { ...next, settings: { ...next.settings, alerts: normalizeAlerts(next.settings.alerts) }, projects: next.projects.map((project) => {
        const tabs = project.tabs.map((tab) => {
          if (tab.cells.length < 1 || tab.cells.length > MAX_CELLS) throw new Error('Concurrent grid change exceeds the cell limit.');
          return tab.layout.areas.length === tab.cells.length ? tab : { ...tab, layout: layoutForCount(tab.cells.length) };
        });
        // Untouched projects keep their identity, so the change that is sent on is computed cheaply.
        return tabs.every((tab, i) => tab === project.tabs[i]) ? project : { ...project, tabs };
      }) };
    }, edit.id);
  }
}
