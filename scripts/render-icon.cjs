// Render the canonical vector mark to the cross-platform Electron Builder icon.
// Run with Node; the script launches its own hidden Electron renderer.
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow } = electron;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, useContentSize: true, show: false, transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true },
  });
  const svg = readFileSync(resolve(__dirname, '../resources/logo.svg'), 'utf8');
  const html = `<html><head><style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style></head><body>${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const icon = await win.webContents.capturePage();
  if (icon.isEmpty() || icon.getSize().width !== 1024) throw new Error('Icon rendering failed');
  writeFileSync(resolve(__dirname, '../resources/icon.png'), icon.toPNG());
  console.log('Rendered resources/icon.png (1024×1024) from resources/logo.svg');
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
