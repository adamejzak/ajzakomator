import { contextBridge, ipcRenderer } from 'electron';
import { release } from 'os';
import type { McApi } from './api';
import { appPlatform } from '../shared/platform';

// MessagePorts can't cross the context bridge; forward the pty data port to the page.
ipcRenderer.on('pty-port', (e) => window.postMessage('mc:pty-port', '*', e.ports));

const api: McApi = {
  platform: appPlatform(process.platform),
  loadState: () => ipcRenderer.invoke('state:load'),
  loadSnapshot: () => ipcRenderer.invoke('state:snapshot'),
  applyStateEdit: (edit) => ipcRenderer.invoke('state:edit', edit),
  getMcpInfo: () => ipcRenderer.invoke('mcp:info'),
  automation: (operation, input) => ipcRenderer.invoke('automation:execute', operation, input),
  spawnCell: (req) => ipcRenderer.invoke('cell:spawn', req),
  cliStatus: () => ipcRenderer.invoke('cli:status'),
  cliRecheck: (id) => ipcRenderer.invoke('cli:recheck', id),
  cliOpenDocs: (id) => ipcRenderer.send('cli:openDocs', id),
  killCell: (cellId) => ipcRenderer.send('cell:kill', cellId),
  killCellAndWait: (cellId) => ipcRenderer.invoke('cell:killAndWait', cellId),
  bindCodexSession: (cellId, cwd) => ipcRenderer.invoke('codex:bind', cellId, cwd),
  aliveCells: () => ipcRenderer.invoke('cell:alive'),
  reportCellStatus: (cellId, status, reason, hooked) => ipcRenderer.send('cell:runtime', cellId, status, reason, hooked),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickSoundFile: () => ipcRenderer.invoke('sound:pick'),
  loadAlertSound: (event, knownKey) => ipcRenderer.invoke('sound:load', event, knownKey),
  systemBeep: () => ipcRenderer.send('sound:beep'),
  pathExists:(path) => ipcRenderer.invoke('fs:exists', path),
  listProjectDirectory: (projectId, path = '') => ipcRenderer.invoke('fs:listProjectDirectory', projectId, path),
  writeProjectFile: (projectId, path, text, expectedText) => ipcRenderer.invoke('fs:writeProjectFile', projectId, path, text, expectedText),
  readProjectFile: (projectId, path) => ipcRenderer.invoke('fs:readProjectFile', projectId, path),
  listProjectDirectories: (projectId) => ipcRenderer.invoke('fs:listProjectDirectories', projectId),
  searchProject: (projectId, options) => ipcRenderer.invoke('fs:searchProject', projectId, options),
  replaceInProject: (projectId, request) => ipcRenderer.invoke('fs:replaceInProject', projectId, request),
  listSessions: (projectPath) => ipcRenderer.invoke('sessions:list', projectPath),
  isGitRepo: (path) => ipcRenderer.invoke('git:isRepo', path),
  createWorktree: (projectPath, name) => ipcRenderer.invoke('git:createWorktree', projectPath, name),
  removeWorktree: (projectPath, wt, deleteBranch) => ipcRenderer.invoke('git:removeWorktree', projectPath, wt, deleteBranch),
  notify: (n) => ipcRenderer.send('notify', n),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  openPath: (path) => ipcRenderer.send('shell:openPath', path),
  revealPath: (path) => ipcRenderer.send('shell:revealPath', path),
  openInEditor: (path) => ipcRenderer.send('shell:openInEditor', path),
  // Electron removed `clipboard` from preload/renderer; main owns it.
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  windowsBuild: process.platform === 'win32' ? Number(release().split('.')[2]) || 0 : 0,
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  openReleases: () => ipcRenderer.send('update:open'),
  getChangelog: (force) => ipcRenderer.invoke('changelog:get', !!force),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  refreshUsage: () => ipcRenderer.invoke('usage:refresh'),
  startLogin: (request) => ipcRenderer.invoke('auth:start', request),
  cancelLogin: (id) => ipcRenderer.send('auth:cancel', id),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  makeMainAccount: (id) => ipcRenderer.invoke('accounts:makeMain', id),
  swapPending: () => ipcRenderer.invoke('accounts:swapPending'),
  clearSwapPending: () => ipcRenderer.invoke('accounts:clearSwapPending'),
  on: (channel: string, cb: (...args: any[]) => void) => {
    const listener = (_e: unknown, ...args: any[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('mc', api);
