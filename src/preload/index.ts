import { contextBridge, ipcRenderer } from 'electron';
import { release } from 'os';
import type { McApi } from './api';

// MessagePorts can't cross the context bridge; forward the pty data port to the page.
ipcRenderer.on('pty-port', (e) => window.postMessage('mc:pty-port', '*', e.ports));

const api: McApi = {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.send('state:save', state),
  spawnCell: (req) => ipcRenderer.invoke('cell:spawn', req),
  killCell: (cellId) => ipcRenderer.send('cell:kill', cellId),
  killCellAndWait: (cellId) => ipcRenderer.invoke('cell:killAndWait', cellId),
  bindCodexSession: (cellId, cwd) => ipcRenderer.invoke('codex:bind', cellId, cwd),
  aliveCells: () => ipcRenderer.invoke('cell:alive'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pathExists: (path) => ipcRenderer.invoke('fs:exists', path),
  listSessions: (projectPath) => ipcRenderer.invoke('sessions:list', projectPath),
  isGitRepo: (path) => ipcRenderer.invoke('git:isRepo', path),
  createWorktree: (projectPath, name) => ipcRenderer.invoke('git:createWorktree', projectPath, name),
  removeWorktree: (projectPath, wt, deleteBranch) => ipcRenderer.invoke('git:removeWorktree', projectPath, wt, deleteBranch),
  notify: (n) => ipcRenderer.send('notify', n),
  openPath: (path) => ipcRenderer.send('shell:openPath', path),
  openInEditor: (path) => ipcRenderer.send('shell:openInEditor', path),
  // Electron removed `clipboard` from preload/renderer; main owns it.
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  windowsBuild: Number(release().split('.')[2]) || 0,
  getUpdate: () => ipcRenderer.invoke('update:get'),
  installUpdate: () => ipcRenderer.send('update:install'),
  openReleases: () => ipcRenderer.send('update:open'),
  on: (channel: string, cb: (...args: any[]) => void) => {
    const listener = (_e: unknown, ...args: any[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('mc', api);
