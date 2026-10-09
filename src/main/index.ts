import { spawn, spawnSync } from 'child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SpawnCellRequest } from '../preload/api';
import { cleanEnv } from '../shared/env';
import type { HostToMain } from '../shared/ipc';
import { buildLaunchCommand } from '../shared/profiles';
import type { AppState, Worktree } from '../shared/types';
import { appPlatform } from '../shared/platform';
import { detectLanguage } from '../shared/languages';
import { translate, type MessageKey, type MessageParams } from '../shared/i18n';
import { HookServer } from './hooks';
import { listProjectDirectory, readProjectFile, writeProjectFile } from './files';
import { PtyHostClient } from './ptyHostClient';
import { claudeProjectDirName, findRecentCodexSession, listSessions } from './sessions';
import { createSaver, loadState } from './store';
import { checkForUpdates, getUpdateState, initUpdater, installNow, installOnQuit, RELEASES_URL } from './updater';
import { createWorktree, isGitRepo, removeWorktree } from './worktree';
import { StateController } from './stateController';
import { AutomationService } from './automation';
import { AjzakomatorMcpServer } from './mcp';
import { queueCodexMessage } from './agentDelivery';
import { automationSchemas, type AutomationOperation, type McpInfo } from '../shared/automation';
import type { StateEdit } from '../shared/stateEdits';
import { findCell, getProfile } from '../shared/state';

const DATA_DIR = process.env.MC_DATA_DIR || join(app.getPath('appData'), 'ajzakomator');
// Carry over state from the app's previous name.
const LEGACY_STATE = join(app.getPath('appData'), 'MultiCoding', 'state.json');
if (!process.env.MC_DATA_DIR && !existsSync(join(DATA_DIR, 'state.json')) && existsSync(LEGACY_STATE)) {
  mkdirSync(DATA_DIR, { recursive: true });
  copyFileSync(LEGACY_STATE, join(DATA_DIR, 'state.json'));
}
const HOOKS_DIR = join(DATA_DIR, 'hooks');
const PROMPTS_DIR = join(DATA_DIR, 'prompts');
const MCP_DIR = join(DATA_DIR, 'mcp');
app.setPath('userData', DATA_DIR);
if (process.platform === 'win32') app.setAppUserModelId('com.ajzakomator.app');

if (process.env.MC_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.MC_DEBUG_PORT);
if (!process.env.MC_DATA_DIR && !app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let state: AppState = loadState(DATA_DIR, appPlatform(process.platform));
const tr = (key: MessageKey, params?: MessageParams) => translate(state.settings.language ?? detectLanguage([app.getLocale()]), key, params);
const saver = createSaver(DATA_DIR);
const ptyHost = new PtyHostClient();
const hooks = new HookServer();
const alive = new Set<string>();
/** Codex session ids handed to cells this run (state may lag behind the renderer). */
const claimedCodex = new Set<string>();
/** Live notifications — Windows drops click handlers of garbage-collected ones. */
const notifications = new Set<Notification>();
/** Only sessions explicitly chosen by the user authorize native message delivery. */
const verifiedCodex = new Map<string, string>();
let mcpError: string | undefined;

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

const controller = new StateController(state, (snapshot) => {
  for (const project of state.projects) for (const tab of project.tabs) for (const cell of tab.cells) {
    if (cell.role && !findCell(snapshot.state, cell.id)?.cell.role) mcp.revokeCell(cell.id);
  }
  state = snapshot.state;
  saver.save(state);
  send('state:changed', snapshot);
});
const automation = new AutomationService(controller, {
  createWorktree,
  removeWorktree: (path, wt) => removeWorktree(path, wt, true),
  startCells: (ids) => send('automation:start-cells', ids),
  stopCells: async (ids) => {
    for (const id of ids) { mcp.revokeCell(id); verifiedCodex.delete(id); alive.delete(id); automation.statuses.set(id, 'exited'); }
    await Promise.all(ids.map((id) => ptyHost.killAndWait(id)));
  },
  isCellRunning: (cellId) => alive.has(cellId),
  restartAgent: async (cellId) => {
    const found = findCell(state, cellId);
    if (!found || !alive.has(cellId)) return { restarted: false, reason: 'Agent is not running.' };
    const profile = getProfile(state, found.cell.profileId);
    const session = found.cell.session;
    if (!session || session.cli !== profile.cli || !session.confirmed) return { restarted: false, reason: 'Choose a compatible conversation from History before restarting through MCP.' };
    const cwd = found.cell.worktree?.path ?? found.project.path;
    if (!existsSync(cwd)) return { restarted: false, reason: 'Project folder does not exist.' };
    mcp.revokeCell(cellId);
    verifiedCodex.delete(cellId);
    alive.delete(cellId);
    await ptyHost.killAndWait(cellId);
    const result = spawnRequest({ cellId, cwd, profile, mode: 'resume', sessionId: session.id, sessionConfirmed: true, cols: 100, rows: 30 });
    if (result.ok) send('cell:restarted', cellId);
    return { restarted: result.ok, reason: result.ok ? undefined : result.error };
  },
  deliver: async (cellId, text) => {
    const found = findCell(state, cellId);
    if (!found || !alive.has(cellId)) throw new Error('Agent is not running. The item is available in its MCP inbox.');
    if (getProfile(state, found.cell.profileId).cli !== 'codex') throw new Error('Available in the MCP inbox. Use Paste to insert it into this agent without submitting.');
    const sessionId = verifiedCodex.get(cellId);
    if (!sessionId || found.cell.session?.id !== sessionId) throw new Error('Session identity is not verified. The item is available in the MCP inbox.');
    await queueCodexMessage(sessionId, text);
  },
});
const mcp = new AjzakomatorMcpServer(automation);

function createWindow(): void {
  win = new BrowserWindow({
    width: process.env.MC_OFFSCREEN ? 1100 : 1600,
    height: process.env.MC_OFFSCREEN ? 700 : 1000,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#0d0d0d',
    title: 'ajzakomator',
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: '#0d0d0d', symbolColor: '#8a8a8a', height: 36 } }),
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true },
    // Off-screen, non-focusable window for automated screenshots (docs).
    ...(process.env.MC_OFFSCREEN ? { x: -6000, y: 0, skipTaskbar: true, focusable: false } : {}),
  });
  win.once('ready-to-show', () => (process.env.MC_OFFSCREEN ? win?.showInactive() : win?.show()));
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
  if (m.t === 'spawned') { automation.runtimeStarted(m.id); alive.add(m.id); automation.statuses.set(m.id, 'unknown'); }
  else if (m.t === 'exit') {
    alive.delete(m.id);
    verifiedCodex.delete(m.id);
    mcp.revokeCell(m.id);
    automation.statuses.set(m.id, 'exited');
  } else if (m.t === 'spawnError') {
    alive.delete(m.id);
    mcp.revokeCell(m.id);
    automation.statuses.set(m.id, 'exited');
    send('cell:spawnError', m.id, m.message);
  }
});
ptyHost.on('crashed', () => {
  for (const id of alive) { mcp.revokeCell(id); automation.statuses.set(id, 'exited'); }
  verifiedCodex.clear();
  alive.clear();
  send('ptyhost:crashed');
});
ptyHost.on('fatal', () => {
  alive.clear();
  dialog.showErrorBox('ajzakomator', tr('Proces terminali wielokrotnie się wysypał. Uruchom aplikację ponownie.'));
});

hooks.on('hook', (cellId: string, event: string) => {
  automation.statuses.set(cellId, event === 'prompt' ? 'working' : event === 'stop' ? 'ready' : 'needs_attention');
  send('cell:hook', cellId, event);
});

function boundCodexIds(): Set<string> {
  const ids = new Set<string>(claimedCodex);
  for (const p of state.projects)
    for (const t of [...p.tabs, ...p.archive])
      for (const c of t.cells) if (c.session?.cli === 'codex') ids.add(c.session.id);
  return ids;
}

/**
 * Codex picks its own session id. The renderer calls this right after a Codex cell finished a
 * turn: its rollout file was just written, so the freshest unclaimed one in that cwd is the cell's.
 */
ipcMain.handle('codex:bind', (_e, cellId: string, cwd: string) => {
  const peers = state.projects.flatMap((p) => p.tabs.flatMap((t) => t.cells
    .filter((c) => alive.has(c.id) && getProfile(state, c.profileId).cli === 'codex' && (c.worktree?.path ?? p.path) === cwd)));
  // Shared-directory simultaneous starts are ambiguous. Never guess a message recipient.
  if (peers.length !== 1 || peers[0].id !== cellId) return null;
  const id = findRecentCodexSession(homedir(), cwd, 20_000, boundCodexIds());
  if (!id) return null;
  claimedCodex.add(id);
  send('cell:session', cellId, { cli: 'codex', id, confirmed: false });
  return id;
});

// ── ipc ─────────────────────────────────────────────────────────────────────

ipcMain.handle('state:load', () => state);
ipcMain.handle('state:snapshot', () => controller.snapshot());
ipcMain.handle('state:edit', (_e, edit: StateEdit) => controller.apply(edit));
ipcMain.handle('mcp:info', (): McpInfo => ({ ...mcp.getInfo(), error: mcpError }));
ipcMain.handle('automation:execute', (_e, operation: AutomationOperation, input: unknown) => {
  if (!Object.hasOwn(automationSchemas, operation)) throw new Error('Unknown operation.');
  return automation.execute(operation, input);
});

ipcMain.handle('cell:spawn', (_e, req: SpawnCellRequest) => spawnRequest(req));
function spawnRequest(req: SpawnCellRequest): { ok: true } | { ok: false; error: string } {
  if (!existsSync(req.cwd)) return { ok: false, error: tr('Folder nie istnieje: {path}', { path: req.cwd }) };
  const claudeSettingsPath = req.profile.cli === 'claude' ? hooks.writeClaudeSettings(HOOKS_DIR, req.cellId) : undefined;
  let mode = req.mode;
  // Claude only writes a transcript after the first prompt: resuming an unused id would fail,
  // so start a new conversation that keeps the same id instead.
  if (mode === 'resume' && req.profile.cli === 'claude' && req.sessionId) {
    const file = join(homedir(), '.claude', 'projects', claudeProjectDirName(req.cwd), `${req.sessionId}.jsonl`);
    if (!existsSync(file)) mode = 'new';
  }
  if (mode === 'resume' && !req.sessionId) mode = 'new';
  let initialPrompt: { file: string; text: string } | undefined;
  if (mode === 'new' && req.startupPrompt?.trim()) {
    mkdirSync(PROMPTS_DIR, { recursive: true });
    const file = join(PROMPTS_DIR, `${req.cellId}.txt`);
    writeFileSync(file, req.startupPrompt, 'utf8');
    initialPrompt = { file, text: req.startupPrompt };
  }
  const env: Record<string, string> = { ...cleanEnv(process.env), MC_CELL_ID: req.cellId };
  let mcpConfig: { url: string; tokenEnv: string; claudeConfigPath: string } | undefined;
  if (req.profile.cli !== 'shell' && findCell(state, req.cellId)?.cell.role && mcp.getInfo().running) {
    env.AJZ_MCP_TOKEN = mcp.issueToken(req.cellId);
    const url = mcp.getInfo().url!;
    mkdirSync(MCP_DIR, { recursive: true });
    const claudeConfigPath = join(MCP_DIR, `${req.cellId}.json`);
    writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: { ajzakomator: {
      type: 'http', url, headers: { Authorization: 'Bearer ${AJZ_MCP_TOKEN}' },
    } } }), 'utf8');
    mcpConfig = { url, tokenEnv: 'AJZ_MCP_TOKEN', claudeConfigPath };
  } else mcp.revokeCell(req.cellId);
  const command = buildLaunchCommand(req.profile, { mode, sessionId: req.sessionId, claudeSettingsPath,
    shell: state.settings.shell, model: findCell(state, req.cellId)?.cell.model, initialPrompt, mcp: mcpConfig }) ?? undefined;
  verifiedCodex.delete(req.cellId);
  if (req.profile.cli === 'codex' && mode === 'resume' && req.sessionId && req.sessionConfirmed) verifiedCodex.set(req.cellId, req.sessionId);
  automation.runtimeStarted(req.cellId);
  automation.statuses.set(req.cellId, 'starting');
  alive.add(req.cellId);
  ptyHost.spawn({ id: req.cellId, cwd: req.cwd, cols: req.cols, rows: req.rows, env, shell: state.settings.shell, command });
  return { ok: true };
}
ipcMain.on('cell:kill', (_e, id: string) => {
  mcp.revokeCell(id);
  verifiedCodex.delete(id);
  automation.statuses.set(id, 'exited');
  alive.delete(id);
  ptyHost.kill(id);
});
ipcMain.handle('cell:killAndWait', async (_e, id: string) => {
  mcp.revokeCell(id);
  verifiedCodex.delete(id);
  automation.statuses.set(id, 'exited');
  alive.delete(id);
  await ptyHost.killAndWait(id);
});
ipcMain.handle('cell:alive', () => [...alive]);
ipcMain.on('cell:runtime', (_e, cellId: string, status: string) => {
  const found = findCell(state, cellId);
  if (!found || !alive.has(cellId) || getProfile(state, found.cell.profileId).cli !== 'codex') return;
  // TUI heuristics can indicate activity or a request for attention, never precise readiness.
  if (status === 'working') automation.statuses.set(cellId, 'working');
  else if (status === 'waiting' && automation.statuses.get(cellId) !== 'ready') automation.statuses.set(cellId, 'needs_attention');
  else if (status === 'idle' && automation.statuses.get(cellId) !== 'ready') automation.statuses.set(cellId, 'unknown');
});

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: tr('Wybierz folder projektu') });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('fs:exists', (_e, p: string) => existsSync(p));
ipcMain.handle('fs:listProjectDirectory', (_e, projectId: string, path: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? listProjectDirectory(project.path, path) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:readProjectFile', (_e, projectId: string, path: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? readProjectFile(project.path, path) : { kind: 'error', message: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:writeProjectFile', (_e, projectId: string, path: string, text: string, expectedText: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? writeProjectFile(project.path, path, text, expectedText) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('sessions:list', (_e, projectPath: string) => listSessions(homedir(), projectPath));
ipcMain.handle('git:isRepo', (_e, p: string) => isGitRepo(p));
ipcMain.handle('git:createWorktree', (_e, p: string, name: string) => createWorktree(p, name));
ipcMain.handle('git:removeWorktree', (_e, p: string, wt: Worktree, del: boolean) => removeWorktree(p, wt, del));

ipcMain.on('notify', (_e, n: { title: string; body: string; cellId: string }) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: n.title, body: n.body, silent: false });
  notifications.add(notification);
  const forget = () => notifications.delete(notification);
  notification.on('close', forget);
  notification.on('failed', forget);
  notification.on('click', () => {
    forget();
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
ipcMain.on('shell:openExternal', (_e, address: string) => {
  try { const url = new URL(address); if (['http:', 'https:'].includes(url.protocol)) void shell.openExternal(url.href); } catch { /* invalid address */ }
});
ipcMain.on('shell:openPath', (_e, p: string) => shell.openPath(p));
ipcMain.on('shell:revealPath', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('update:get', () => ({ ...getUpdateState(), currentVersion: app.getVersion() }));
ipcMain.on('update:install', () => installNow());
ipcMain.on('update:open', () => shell.openExternal(RELEASES_URL));
ipcMain.on('shell:openInEditor', (_e, p: string) => {
  // `cursor` / `code` are .cmd launchers → need a shell; they get our clean env.
  const editor = ['cursor', 'code'].find((cmd) => spawnSync(process.platform === 'win32' ? 'where' : '/usr/bin/which', [cmd], { windowsHide: true }).status === 0);
  if (!editor && process.platform === 'darwin') {
    const application = ['Cursor', 'Visual Studio Code'].find((name) =>
      existsSync(join('/Applications', `${name}.app`)) || existsSync(join(homedir(), 'Applications', `${name}.app`)));
    if (application) {
      spawn('/usr/bin/open', ['-a', application, p], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
  }
  if (!editor) return void shell.openPath(p);
  spawn(editor, process.platform === 'win32' ? [`"${p}"`] : [p], { shell: process.platform === 'win32', detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv(process.env) }).unref();
});

// ── lifecycle ───────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  // No default menu: its Ctrl+W / Ctrl+R accelerators would close or reload the window.
  Menu.setApplicationMenu(null);
  await hooks.start();
  try { await mcp.start(); } catch (error) { mcpError = error instanceof Error ? error.message : String(error); }
  ptyHost.start();
  createWindow();
  initUpdater((s) => send('update:state', s));
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  send('app:before-quit');
  // Give the renderer a moment to push its final state, then wind down terminals cleanly.
  setTimeout(async () => {
    try {
      saver.flush();
    } catch (err) {
      console.error('state save failed', err);
    }
    await ptyHost.shutdown();
    await mcp.stop();
    hooks.stop();
    installOnQuit();
    app.exit(0);
  }, 150);
});
app.on('window-all-closed', () => app.quit());
