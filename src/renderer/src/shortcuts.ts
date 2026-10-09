// App-wide shortcuts, handled in the capture phase so they win over the focused terminal.
// Chosen to avoid keys Claude/Codex use themselves (Ctrl+T, Ctrl+B, Ctrl+W, Alt+arrows …).
import { useEffect } from 'react';
import { activeProject, activeTab } from '../../shared/state';
import { addAgent, closeTab, cycleTab, moveFocus, quickTab, toggleMaximize } from './actions';
import { getS, getUi, setUi, update } from './store';
import { hasPrimaryModifier } from './platform';

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.type !== 'keydown') return;
      if (!getS().settings.language) return;
      const primary = hasPrimaryModifier(e);
      const ui = getUi();
      if (ui.dialog || ui.modal || ui.palette) {
        if (primary && !e.altKey && e.code === 'KeyK' && ui.palette) stop(e, () => setUi({ palette: false }));
        return;
      }
      const ctrl = primary && !e.altKey;
      const ctrlShift = ctrl && e.shiftKey;
      const project = activeProject(getS());

      if (ctrl && !e.shiftKey && e.code === 'KeyK') return stop(e, () => setUi({ palette: true }));
      if (ctrlShift && e.code === 'KeyP') return stop(e, () => setUi({ palette: true }));
      if (ctrlShift && e.code === 'KeyT') return stop(e, () => quickTab());
      if (ctrlShift && e.code === 'KeyN') return stop(e, () => void addAgent(getS().settings.lastProfileId));
      if (ctrlShift && e.code === 'KeyG' && project) return stop(e, () => setUi({ modal: { kind: 'grid', projectId: project.id } }));
      if (ctrlShift && e.code === 'KeyH' && project) return stop(e, () => setUi({ modal: { kind: 'history', projectId: project.id } }));
      if (ctrlShift && e.code === 'KeyW' && project) {
        const tab = activeTab(project);
        if (tab) return stop(e, () => closeTab(project.id, tab.id));
      }
      if (ctrlShift && e.code === 'KeyB') return stop(e, () => update((s) => ({ ...s, snippetsOpen: !s.snippetsOpen })));
      if (ctrlShift && e.code === 'KeyE') return stop(e, () => update((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed })));
      if (ctrlShift && e.code === 'KeyM') return stop(e, () => toggleMaximize());
      if (ctrl && e.code === 'Tab') return stop(e, () => cycleTab(e.shiftKey ? -1 : 1));
      if (primary && e.altKey && !e.shiftKey && !e.getModifierState('AltGraph')) {
        const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const d = dir[e.code];
        if (d) return stop(e, () => moveFocus(d[0], d[1]));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function stop(e: KeyboardEvent, fn: () => void): void {
  e.preventDefault();
  e.stopPropagation();
  fn();
}
