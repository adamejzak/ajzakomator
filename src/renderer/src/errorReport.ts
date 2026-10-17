// Renderer errors go to main's crash.log: a packaged build keeps no console, so a crash report would otherwise hold nothing.

/** Sends one error to main; never throws (it runs inside error handlers). `kind`: lowercase letters and dashes. */
export function reportError(kind: string, error: unknown): void {
  try {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    window.mc?.reportError?.(kind, message, stack);
  } catch { /* nothing else to do */ }
}

let installed = false;
/** Uncaught errors and unhandled rejections of the window, once. */
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => reportError('window-error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('unhandled-rejection', e.reason));
}
