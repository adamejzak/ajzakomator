/**
 * Detached update window. It runs from a private copy of the Electron runtime so the installer can
 * replace the installed app while this window keeps showing what is happening.
 */
import { spawn } from 'child_process';
import { app, BrowserWindow, ipcMain } from 'electron';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { UpdateProgressModel, type UpdateSplashConfig, type UpdateStage } from '../shared/updateProgress';

const configPath = process.argv.find((arg) => arg.startsWith('--update-config='))?.slice('--update-config='.length);
if (!configPath) app.exit(2);
const config: UpdateSplashConfig = JSON.parse(readFileSync(configPath!, 'utf8'));

app.setPath('userData', join(config.workDir, 'splash-profile'));
app.commandLine.appendSwitch('lang', 'en-US');
app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.exit(0);

const TICK_MS = 250;
const SIZE_EVERY_MS = 1000;
const FINISH_DELAY_MS = 1100;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Total size of a directory tree; unreadable entries are skipped because the installer is rewriting it. */
function directoryBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        const info = statSync(path);
        if (info.isDirectory()) stack.push(path); else total += info.size;
      } catch { /* removed or locked mid-install */ }
    }
  }
  return total;
}

let win: BrowserWindow | null = null;
let finished = false;

function push(stage: UpdateStage, percent: number, message: string, extra: Record<string, unknown> = {}): void {
  if (win && !win.isDestroyed()) win.webContents.send('update-splash:state', { stage, percent, message, ...extra });
}

function cleanupAndExit(): void {
  // The runtime copy is locked while this process lives. A GUI-subsystem Electron in node mode removes it
  // afterwards without ever creating a console window (no shell involved).
  try {
    const script = `setTimeout(()=>{try{require('fs').rmSync(${JSON.stringify(config.runtimeDir)},{recursive:true,force:true,maxRetries:10,retryDelay:500})}catch{}},3000)`;
    spawn(config.appExe, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref();
  } catch { /* the app removes leftovers on its next start */ }
  app.exit(0);
}

function run(): void {
  const started = Date.now();
  const baseline = directoryBytes(config.installDir);
  const model = new UpdateProgressModel(baseline, config.mode);
  let dirBytes: number | undefined;
  let sampling = false;
  let lastSample = 0;
  let timedOut = false;
  const { strings } = config;

  const timer = setInterval(() => {
    if (finished) return;
    const elapsedMs = Date.now() - started;
    const closed = !alive(config.oldPid);
    if (closed && !sampling && elapsedMs - lastSample >= SIZE_EVERY_MS) {
      sampling = true; lastSample = elapsedMs;
      setImmediate(() => { dirBytes = directoryBytes(config.installDir); sampling = false; });
    }
    if (existsSync(config.abortFlag)) { finished = true; clearInterval(timer); cleanupAndExit(); return; }
    const installed = existsSync(config.installedFlag);
    const ready = existsSync(config.readyFlag);
    const { stage, percent } = model.update({ elapsedMs, closed, installed, ready, dirBytes });

    if (stage === 'done') {
      finished = true; clearInterval(timer);
      push('done', 100, config.mode === 'quit' ? strings.doneQuit : strings.done);
      setTimeout(cleanupAndExit, FINISH_DELAY_MS);
      return;
    }
    if (elapsedMs > config.timeoutMs) {
      if (!timedOut) { timedOut = true; clearInterval(timer); push('error', percent, strings.slow, { detail: strings.slowHint }); }
      return;
    }
    push(stage, percent, strings.stages[stage as keyof typeof strings.stages] ?? '');
  }, TICK_MS);
}

ipcMain.on('update-splash:close', () => cleanupAndExit());
ipcMain.on('update-splash:open', () => {
  try { spawn(config.appExe, [], { detached: true, stdio: 'ignore', cwd: config.installDir }).unref(); } catch { /* nothing else to try */ }
  cleanupAndExit();
});
ipcMain.handle('update-splash:init', () => ({
  title: config.strings.title, hint: config.strings.hint, fromVersion: config.fromVersion, version: config.version,
  open: config.strings.open, close: config.strings.close,
}));

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 440, height: 200, resizable: false, maximizable: false, minimizable: true, fullscreenable: false,
    frame: false, show: false, center: true, alwaysOnTop: true, backgroundColor: '#0d0d0d', title: 'ajzakomator',
    icon: join(__dirname, '../ui/icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/updatesplash.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setMenu(null);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => {
    win?.show();
    try { writeFileSync(config.shownFlag, String(Date.now())); } catch { /* the app only waits a few seconds for this */ }
    run();
  });
  void win.loadFile(join(__dirname, '../ui/index.html'));
});
app.on('window-all-closed', () => { if (!finished) cleanupAndExit(); });
