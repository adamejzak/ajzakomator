import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('updateSplash', {
  init: () => ipcRenderer.invoke('update-splash:init'),
  onState: (cb: (s: unknown) => void) => { ipcRenderer.on('update-splash:state', (_e, s) => cb(s)); },
  close: () => ipcRenderer.send('update-splash:close'),
  open: () => ipcRenderer.send('update-splash:open'),
});
