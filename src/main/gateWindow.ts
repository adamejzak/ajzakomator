import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import type { UpdateStage } from '../shared/updateProgress';
import type { GateView } from './startupGate';
import { safeSend } from './safeWindow';

export interface GateTexts {
  checking: string;
  downloading: string;
  /** Title of the update, with the version filled in. */
  updating: (version: string) => string;
  hint: string;
  preparing: string;
  failed: string;
  close: string;
}

interface SplashState { stage: UpdateStage; percent: number; message: string; title?: string; versions?: string; hint?: string; closable?: boolean }

/** Maps what the startup check is doing to what the update window shows. */
export function gateState(view: GateView, texts: GateTexts, currentVersion: string): SplashState {
  switch (view.kind) {
    case 'checking':
      return { stage: 'checking', percent: 0, message: '', title: texts.checking, versions: currentVersion, hint: '', closable: true };
    case 'downloading':
      return { stage: 'downloading', percent: view.percent, message: texts.downloading, title: texts.updating(view.version), versions: `${currentVersion} → ${view.version}`, hint: texts.hint, closable: true };
    // From here the installer is being started and the window cannot be cancelled any more.
    case 'installing':
      return { stage: 'downloading', percent: 100, message: texts.preparing, title: texts.updating(view.version), versions: `${currentVersion} → ${view.version}`, hint: texts.hint, closable: false };
    case 'failed':
      return { stage: 'failed', percent: 0, message: texts.failed, title: texts.updating(view.version), versions: `${currentVersion} → ${view.version}`, hint: '', closable: false };
  }
}

/**
 * The update window shown inside the app process while the startup check runs. It reuses the page of the
 * detached update window; the detached one takes over (same size and place) when the installer starts.
 */
export function createGateWindow(texts: GateTexts, currentVersion: string): { show(view: GateView): void; hide(): void; onCancel(cancel: () => void): void } {
  let win: BrowserWindow | null = null;
  let latest: SplashState | undefined;
  let loaded = false;

  let cancel: (() => void) | undefined;
  const push = () => { if (loaded && latest) safeSend(win, 'update-splash:state', latest); };
  /** The user closed the window (X, Escape, Alt+F4); the gate decides whether that is still allowed. */
  const requestClose = () => { if (latest?.closable) cancel?.(); };

  const create = () => {
    ipcMain.removeHandler('update-splash:init');
    ipcMain.handle('update-splash:init', () => ({
      title: latest?.title ?? '', hint: latest?.hint ?? '', fromVersion: currentVersion, version: '', state: latest, open: '', close: texts.close,
    }));
    win = new BrowserWindow({
      width: 440, height: 200, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      frame: false, show: false, center: true, alwaysOnTop: true, backgroundColor: '#0d0d0d', title: 'ajzakomator',
      icon: join(app.getAppPath(), 'resources', 'icon.png'),
      ...(!app.isPackaged && process.env.MC_OFFSCREEN ? { x: -6000, y: 0, skipTaskbar: true, focusable: false } : {}),
      webPreferences: { preload: join(__dirname, '../preload/updatesplash.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenu(null);
    ipcMain.removeAllListeners('update-splash:close');
    ipcMain.on('update-splash:close', requestClose);
    win.on('close', (e) => { if (latest?.closable) { e.preventDefault(); requestClose(); } });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Closed by the user: forget the window so the next update shows a new one.
    const created = win;
    created.once('closed', () => { if (win === created) { win = null; loaded = false; } });
    win.webContents.on('did-finish-load', () => { loaded = true; push(); });
    win.once('ready-to-show', () => { if (!app.isPackaged && process.env.MC_OFFSCREEN) win?.showInactive(); else win?.show(); });
    void win.loadFile(join(app.getAppPath(), 'resources', 'update-splash', 'index.html'));
  };

  return {
    show(view) {
      latest = gateState(view, texts, currentVersion);
      if (!win) create(); else push();
    },
    onCancel(callback) { cancel = callback; },
    hide() {
      ipcMain.removeHandler('update-splash:init');
      ipcMain.removeAllListeners('update-splash:close');
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      loaded = false;
    },
  };
}
