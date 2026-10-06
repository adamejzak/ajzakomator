import { spawn } from 'child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SpawnCellRequest } from '../preload/api';
import { cleanEnv } from '../shared/env';
import type { HostToMain } from '../shared/ipc';
import { buildLaunchCommand } from '../shared/profiles';
import type { AppState, Worktree } from '../shared/types';
import { HookServer } from './hooks';
import { PtyHostClient } from './ptyHostClient';
import { claudeProjectDirName, findNewCodexSession, listSessions } from './sessions';
import { createSaver, loadState } from './store';
import { createWorktree, isGitRepo, removeWorktree } from './worktree';

const DATA_DIR = process.env.MC_DATA_DIR || join(app.getPath('appData'), 'MultiCoding');
const HOOKS_DIR = join(DATA_DIR, 'hooks');
app.setPath('userData', DATA_DIR);
app.setAppUserModelId('com.multicoding.app');

if (process.env.MC_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.MC_DEBUG_PORT);
if (!process.env.MC_DATA_DIR && !app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let state: AppState = loadState(DATA_DIR);
const saver = createSaver(DATA_DIR);
const ptyHost = new PtyHostClient();
const hooks = new HookServer();
const alive = new Set<string>();
const codexWatch = new Map<string, NodeJS.Timeout>();

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#0d0d0d',
    title: 'MultiCoding',
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0d0d', symbolColor: '#8a8a8a', height: 36 },
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true },
  });
  win.once('ready-to-show', () => win?.show());
  if (!app.isPackaged) win.webContents.on('console-message', (e) => e.level !== 'debug' && console.log('[renderer]', e.level, e.message));
  win.webContents.on('did-finish-load', () => win && ptyHost.connectRenderer(win.webContents));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

// ── pty host ────────────────────────────────────────────────────────────────

ptyHost.on('message', (m: HostToMain) => {
  if (m.t === 'spawned') alive.add(m.id);
  else if (m.t === 'exit') {
    alive.delete(m.id);
    stopCodexWatch(m.id);
  } else if (m.t === 'spawnError') {
    alive.delete(m.id);
    send('cell:spawnError', m.id, m.message);
  }
});
ptyHost.on('crashed', () => {
  alive.clear();
  send('ptyhost:crashed');
});

hooks.on('hook', (cellId: string, event: string) => send('cell:hook', cellId, event));

function boundCodexIds(): Set<string> {
  const ids = new Set<string>();
  for (const p of state.projects)
    for (const t of [...p.tabs, ...p.archive])
      for (const c of t.cells) if (c.session?.cli === 'codex') ids.add(c.session.id);
  return ids;
}

function stopCodexWatch(cellId: string): void {
  const t = codexWatch.get(cellId);
  if (t) clearInterval(t);
  codexWatch.delete(cellId);
}

/** Codex picks its own session id; find its new rollout file and bind it to the cell. */
function watchCodexSession(cellId: string, cwd: string): void {
  stopCodexWatch(cellId);
  const since = Date.now();
  const deadline = since + 30 * 60 * 1000;
  const timer = setInterval(() => {
    if (Date.now() > deadline || !alive.has(cellId)) return stopCodexWatch(cellId);
    const id = findNewCodexSession(homedir(), cwd, since, boundCodexIds());
    if (id) {
      stopCodexWatch(cellId);
      send('cell:session', cellId, { cli: 'codex', id });
    }
  }, 3000);
  codexWatch.set(cellId, timer);
}

// ── ipc ─────────────────────────────────────────────────────────────────────

ipcMain.handle('state:load', () => state);
ipcMain.on('state:save', (_e, s: AppState) => {
  state = s;
  saver.save(s);
});

ipcMain.handle('cell:spawn', (_e, req: SpawnCellRequest) => {
  if (!existsSync(req.cwd)) return { ok: false, error: `Folder nie istnieje: ${req.cwd}` };
  const claudeSettingsPath = req.profile.cli === 'claude' ? hooks.writeClaudeSettings(HOOKS_DIR, req.cellId) : undefined;
  let mode = req.mode;
  // Claude only writes a transcript after the first prompt: resuming an unused id would fail,
  // so start a new conversation that keeps the same id instead.
  if (mode === 'resume' && req.profile.cli === 'claude' && req.sessionId) {
    const file = join(homedir(), '.claude', 'projects', claudeProjectDirName(req.cwd), `${req.sessionId}.jsonl`);
    if (!existsSync(file)) mode = 'new';
  }
  if (mode === 'resume' && !req.sessionId) mode = 'new';
  const command = buildLaunchCommand(req.profile, { mode, sessionId: req.sessionId, claudeSettingsPath }) ?? undefined;
  const env = { ...cleanEnv(process.env), MC_CELL_ID: req.cellId };
  alive.add(req.cellId);
  ptyHost.spawn({ id: req.cellId, cwd: req.cwd, cols: req.cols, rows: req.rows, env, shell: state.settings.shell, command });
  if (req.profile.cli === 'codex' && mode === 'new') watchCodexSession(req.cellId, req.cwd);
  return { ok: true };
});
ipcMain.on('cell:kill', (_e, id: string) => {
  alive.delete(id);
  stopCodexWatch(id);
  ptyHost.kill(id);
});
ipcMain.handle('cell:alive', () => [...alive]);

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Wybierz folder projektu' });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('fs:exists', (_e, p: string) => existsSync(p));
ipcMain.handle('sessions:list', (_e, projectPath: string) => listSessions(homedir(), projectPath));
ipcMain.handle('git:isRepo', (_e, p: string) => isGitRepo(p));
ipcMain.handle('git:createWorktree', (_e, p: string, name: string) => createWorktree(p, name));
ipcMain.handle('git:removeWorktree', (_e, p: string, wt: Worktree, del: boolean) => removeWorktree(p, wt, del));

ipcMain.on('notify', (_e, n: { title: string; body: string; cellId: string }) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: n.title, body: n.body, silent: false });
  notification.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('focus-cell', n.cellId);
  });
  notification.show();
});
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text));
ipcMain.on('shell:openPath', (_e, p: string) => shell.openPath(p));
ipcMain.on('shell:openInEditor', (_e, p: string) => {
  // `cursor` / `code` are .cmd launchers → need a shell; they get our clean env.
  const child = spawn('cursor', [`"${p}"`], { shell: true, detached: true, stdio: 'ignore', env: cleanEnv(process.env) });
  child.on('error', () => spawn('code', [`"${p}"`], { shell: true, detached: true, stdio: 'ignore' }));
  child.unref();
});

// ── lifecycle ───────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  await hooks.start();
  ptyHost.start();
  createWindow();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  send('app:before-quit');
  // Give the renderer a moment to push its final state, then wind down terminals cleanly.
  setTimeout(async () => {
    saver.flush();
    for (const id of codexWatch.keys()) stopCodexWatch(id);
    await ptyHost.shutdown();
    hooks.stop();
    app.exit(0);
  }, 150);
});
app.on('window-all-closed', () => app.quit());
