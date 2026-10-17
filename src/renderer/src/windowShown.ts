// Whether anybody can see the main window. The window runs without background throttling, so `document.visibilityState`
// stays 'visible' while it is minimized or hidden; main reports those states on 'window:shown'.
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
