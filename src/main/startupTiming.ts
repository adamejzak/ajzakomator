// Startup timing (0.9.4): milliseconds since the process started (performance.now()) for each startup step, written as one line
// per launch to startup.log in the data directory (the last launches only), so a slow start can be measured and compared.
// No Electron imports, so it is tested in Node.
import { readFile, writeFile } from 'fs/promises';

/** Marks the renderer may report (anything else from the renderer is ignored). */
export const RENDERER_MARKS = ['renderer-boot', 'first-output'] as const;
export type RendererMark = (typeof RENDERER_MARKS)[number];
export const isRendererMark = (name: unknown): name is RendererMark => typeof name === 'string' && (RENDERER_MARKS as readonly string[]).includes(name);

/** Launches kept in startup.log. */
export const STARTUP_LOG_LINES = 20;

export interface StartupTimer {
  /** Records `name` once (a later mark of the same name, such as a reloaded window, is ignored). */
  mark(name: string): void;
  has(name: string): boolean;
  /** `name=ms` pairs in the order they happened. */
  line(): string;
}

export function createStartupTimer(now: () => number): StartupTimer {
  const marks = new Map<string, number>();
  return {
    mark: (name) => { if (!marks.has(name)) marks.set(name, now()); },
    has: (name) => marks.has(name),
    line: () => [...marks].map(([name, ms]) => `${name}=${Math.round(ms)}`).join(' '),
  };
}

/** The log with this launch's line last, older launches trimmed to `keep` lines in total. */
export function startupLogText(previous: string[], current: string, keep = STARTUP_LOG_LINES): string {
  return `${[...previous, current].slice(-keep).join('\n')}\n`;
}

/**
 * Writes this launch's line to `file`, replacing the line an earlier flush of the same launch wrote. Never throws and never
 * blocks the main thread (async file calls, one at a time).
 */
export function createStartupLog(file: string, header: string, timer: StartupTimer, fs = { readFile, writeFile }): { flush(): Promise<void> } {
  let previous: Promise<string[]> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const older = () => (previous ??= fs.readFile(file, 'utf8')
    .then((text) => text.split(/\r?\n/).filter((line) => line.trim() !== ''))
    .catch(() => []));
  return {
    flush: () => {
      chain = chain.then(async () => {
        const lines = await older();
        await fs.writeFile(file, startupLogText(lines, `${header} ${timer.line()}`), 'utf8');
      }).catch(() => undefined);
      return chain;
    },
  };
}
