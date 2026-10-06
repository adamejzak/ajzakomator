import { app, BrowserWindow } from 'electron';
import { join } from 'path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#0d0d0d',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
