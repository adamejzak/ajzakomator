import { execFile } from 'child_process';
import { cleanEnv } from '../shared/env';

/** All user text travels in argv (POSIX) or environment (Windows), never shell source. */
export function queueCodexMessage(sessionId: string, message: string): Promise<void> {
  const windows = process.platform === 'win32';
  const env = { ...cleanEnv(process.env), AJZ_TARGET_SESSION: sessionId, AJZ_TASK_MESSAGE: message };
  const file = windows ? 'powershell.exe' : 'codex';
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; try { & codex queue --thread $env:AJZ_TARGET_SESSION --message $env:AJZ_TASK_MESSAGE; exit $LASTEXITCODE } catch { exit 1 }"]
    : ['queue', '--thread', sessionId, '--message', message];
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 }, (error) => {
      if (error) reject(new Error('Native Codex delivery failed. Check that this Codex version supports queue and the session is running. The item remains in the inbox.'));
      else resolve();
    });
  });
}
