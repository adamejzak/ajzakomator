// "Open in editor": which of Cursor / VS Code is on the PATH, looked up without blocking the main process.
import { execFile } from 'child_process';

export const EDITORS = ['cursor', 'code'] as const;

/** True when `where` / `which` finds the command (asynchronously, with a timeout). */
export function onPath(cmd: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(platform === 'win32' ? 'where' : '/usr/bin/which', [cmd], { windowsHide: true, timeout: 5000 }, (error) => resolve(!error));
  });
}

/** Remembers the editor that was found for the session; a failed start forgets it. Not finding one is asked again next time. */
export function createEditorFinder(lookup: (cmd: string) => Promise<boolean> = (cmd) => onPath(cmd)) {
  let found: string | null = null;
  let running: Promise<string | null> | null = null;
  return {
    find(): Promise<string | null> {
      if (found) return Promise.resolve(found);
      running ??= (async () => {
        try {
          for (const cmd of EDITORS) if (await lookup(cmd)) return (found = cmd);
          return null;
        } finally { running = null; }
      })();
      return running;
    },
    forget(): void { found = null; },
  };
}
