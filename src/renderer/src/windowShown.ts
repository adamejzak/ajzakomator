// Whether anybody can see the main window. The window runs without background throttling, so `document.visibilityState`
// stays 'visible' while it is minimized or hidden; main reports those states on 'window:shown'.
// A window that is only covered keeps drawing: with throttling off Chromium never passes its native occlusion result to the
// page (measured 0.9.4 on Windows: an off-screen window stays 'visible' at the full frame rate), and Electron 44 has no
// occlusion event on Windows or macOS. Terminals draw only when output arrives, so a covered window with quiet cells costs nothing.
let shown = true;
const listeners = new Set<(shown: boolean) => void>();
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  window.mc?.on?.('window:shown', (next) => {
    if (next === shown) return;
    shown = next;
    document.documentElement.dataset.windowShown = String(shown);
    for (const listener of listeners) listener(shown);
  });
}

/** False while the window is minimized or hidden (or the page is hidden, should Chromium still report it). */
export function isWindowShown(): boolean {
  wire();
  return shown && document.visibilityState === 'visible';
}

/** Called on every change reported by main; returns the unsubscribe. */
export function onWindowShown(listener: (shown: boolean) => void): () => void {
  wire();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
