import { createHash } from 'crypto';
import { execFile, spawn, spawnSync } from 'child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, shell, type OpenDialogOptions } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import { listProjectDirectories, listProjectDirectory, readProjectFile, writeProjectFile } from './files';
import { replaceInProject, searchProject } from './search';
import type { ReplaceRequest, SearchOptions } from '../shared/search';
import { PtyHostClient } from './ptyHostClient';
import { claudeProjectDirName, findRecentCodexSession, listSessionsAsync } from './sessions';
import { createSaver, loadState } from './store';
import { abandonStartupCheck, blockUpdateVersion, checkForUpdates, getUpdateState, initUpdater, installNow, isPortableBuild, updateHandoffStarted, RELEASES_URL, startupCheck, startupDownload, startupHandoff, updatesEnabled } from './updater';
import { compareVersions, isRecentFailure, parseFailure, runStartupGate, shouldGateOnStartup } from './startupGate';
import { createGateWindow } from './gateWindow';
import { createDialogLimiter, decideUncaught, handoffWatchdogAction, isLive, safeSend, shouldRelaunchAfterQuit, SHUTDOWN_HARD_LIMIT_MS, withLiveWindow } from './safeWindow';
import { createUpdaterLogger } from './updaterLog';
import { START_BLOCK_MS, abortUpdateWindow, scheduleUpdateCleanup, signalUpdateReady, updateInstalling } from './updateSplash';
import { createChangelog } from './changelog';
import { refreshClaudeProfile, type RefreshOutcome } from './accounts/refresh';
import { handleMakeMain } from './accounts/makeMain';
import { AccountsStore } from './accounts/store';
import { gateProfileRefresh, handleRemoveAccount, loginBlock } from './accounts/guards';
import { clearPendingSwap, hasPendingSwap, isSwapRunning, isSwapUnresolved, recoverInterruptedSwap, swapMainAccount, type SwapDeps } from './accounts/swap';
import { readManagedIdentity } from './accounts/identity';
import { LoginManager } from './auth/login';
import { isAccountId, type LoginRequest } from '../shared/accounts';
import { profileSource, readClaudeCredentials, readClaudeIdentity, readCodexCredentials, systemCredentialSource } from './usage/credentials';
import { fetchClaude, fetchCodex, type FetcherDeps } from './usage/fetchers';
import { UsageService } from './usage/service';
import { MAIN_ACCOUNTS } from '../shared/usage';
import type { UpdateStrings } from '../shared/updateProgress';
import { createWorktree, isGitRepo, removeWorktree } from './worktree';
import { StateController } from './stateController';
import { AutomationService } from './automation';
import { AjzakomatorMcpServer } from './mcp';
import { queueCodexMessage } from './agentDelivery';
import { automationSchemas, type AutomationOperation, type McpInfo } from '../shared/automation';
import type { StateEdit } from '../shared/stateEdits';
import { findCell, getProfile } from '../shared/state';
import { followedSession, shouldUpdateCellSession } from '../shared/sessionTrack';
import { isSoundFile, SOUND_EXTENSIONS } from '../shared/sound';
import { loadSoundFile } from './waitingSound';

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
// Module code keeps running after app.quit(), so every later step checks `superseded` instead of assuming the exit is immediate.
let superseded = !process.env.MC_DATA_DIR && !app.requestSingleInstanceLock();
// The installer is replacing this build's files right now (the update window is showing it); starting would crash.
if (!superseded && process.platform === 'win32' && app.isPackaged && !process.env.MC_DATA_DIR && updateInstalling(START_BLOCK_MS)) superseded = true;
if (superseded) app.exit(0);

let win: BrowserWindow | null = null;
let state: AppState = loadState(DATA_DIR, appPlatform(process.platform));
const tr = (key: MessageKey, params?: MessageParams) => translate(state.settings.language ?? detectLanguage([app.getLocale()]), key, params);
const saver = createSaver(DATA_DIR);
const usageDeps: FetcherDeps = {
  credentials: systemCredentialSource(),
  // net.fetch follows the system proxy settings, like the rest of Chromium. Redirects are refused so a bearer token never follows one.
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => net.fetch(String(input), { ...init, redirect: 'error' })) as typeof fetch,
  now: () => Date.now(),
  codexHome: () => process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
  claudeUrl: (!app.isPackaged && process.env.MC_USAGE_CLAUDE_URL) || 'https://api.anthropic.com/api/oauth/usage',
  codexUrl: (!app.isPackaged && process.env.MC_USAGE_CODEX_URL) || 'https://chatgpt.com/backend-api/wham/usage',
};
const accounts = new AccountsStore(join(DATA_DIR, 'accounts'));
const usage = new UsageService({
  accounts: () => [
    MAIN_ACCOUNTS[0],
    ...accounts.list().map((a) => ({ id: `claude:${a.id}`, provider: 'claude' as const, configDir: accounts.dirOf(a.id) })),
    MAIN_ACCOUNTS[1],
  ],
  fetchAccount: (ref) => (ref.provider === 'claude' ? fetchClaude(usageDeps, ref) : fetchCodex(usageDeps)),
  cacheFile: join(DATA_DIR, 'usage-cache.json'),
  enabled: () => state.settings.showAiUsage,
  intervalMs: () => state.settings.usageIntervalMinutes * 60_000,
});
const execText = (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> => new Promise((resolve) => {
  execFile(command, args, { env: cleanEnv(env), timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }, (error, stdout) => resolve(error ? null : stdout));
});
let usageKey = `${state.settings.showAiUsage}:${state.settings.usageIntervalMinutes}`;
const ptyHost = new PtyHostClient();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const login = new LoginManager({
  store: accounts,
  spawnPty: (spec) => ptyHost.spawn({
    id: spec.id, cwd: homedir(), cols: 100, rows: 28,
    env: { ...cleanEnv(process.env), ...spec.env }, shell: state.settings.shell, command: spec.command,
  }),
  killPty: (id) => ptyHost.kill(id),
  fingerprint: async (provider, configDir) => {
    if (provider === 'claude') {
      const credentials = await readClaudeCredentials(configDir ? profileSource(usageDeps.credentials, configDir) : usageDeps.credentials);
      return credentials ? sha256(credentials.accessToken) : null;
    }
    const credentials = await readCodexCredentials(usageDeps.credentials);
    return credentials?.accessToken ? sha256(credentials.accessToken) : null;
  },
  identity: async (provider, configDir) => {
    if (provider === 'codex') {
      const credentials = await readCodexCredentials(usageDeps.credentials);
      return credentials?.email ? { email: credentials.email } : {};
    }
    if (configDir) return readManagedIdentity(configDir, { source: usageDeps.credentials, exec: execText });
    return readClaudeIdentity(usageDeps.credentials);
  },
  knownEmails: async () => {
    const main = await readClaudeIdentity(usageDeps.credentials);
    return [main.email, ...accounts.list().map((a) => a.email)]
      .filter((email): email is string => typeof email === 'string' && email !== '')
      .map((email) => email.toLowerCase());
  },
  emit: (s) => send('auth:state', s),
  onChanged: () => void usage.refresh(true, true),
  profilesSupported: process.platform !== 'darwin',
  swapRunning: isSwapRunning,
});
const swapDeps = (): SwapDeps => ({
  home: homedir(),
  env: process.env,
  platform: process.platform,
  store: accounts,
  backupDir: join(DATA_DIR, 'accounts', 'swap-backup'),
  now: () => Date.now(),
  refresh: (dir) => refreshClaudeProfile(dir, { fetch: usageDeps.fetch, now: usageDeps.now, tokenUrl: app.isPackaged ? undefined : process.env.MC_USAGE_CLAUDE_TOKEN_URL }),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
const guardDeps = { swapRunning: isSwapRunning, swapPending: () => hasPendingSwap(swapDeps()), swapPendingNow: isSwapUnresolved };
/** Tells the renderer whether an unresolved swap blocks further swaps. */
async function pushSwapPending(): Promise<void> {
  send('accounts:swapPending', await hasPendingSwap(swapDeps()).catch(() => true));
}
// Background refreshes never write into a managed profile while a swap runs or is unresolved.
usageDeps.refreshClaude = gateProfileRefresh<RefreshOutcome>(guardDeps, (dir) => refreshClaudeProfile(dir, { fetch: usageDeps.fetch, now: usageDeps.now, tokenUrl: app.isPackaged ? undefined : process.env.MC_USAGE_CLAUDE_TOKEN_URL }), { kind: 'transient' });
const hooks = new HookServer();
if (process.env.MC_HOOK_DEBUG === '1') hooks.debugDir = DATA_DIR;
const alive = new Set<string>();
/** Codex session ids handed to cells this run (state may lag behind the renderer). */
const claimedCodex = new Set<string>();
/** Live notifications - Windows drops click handlers of garbage-collected ones. */
const notifications = new Set<Notification>();
/** Only sessions explicitly chosen by the user authorize native message delivery. */
const verifiedCodex = new Map<string, string>();
let mcpError: string | undefined;

/** Localized texts for the detached update window (it cannot load the app's catalog). */
const updateStrings = (): UpdateStrings => ({
  title: tr('Aktualizacja do wersji {version}', { version: getUpdateState().version ?? '' }),
  hint: tr('Nie wyłączaj komputera. ajzakomator uruchomi się automatycznie.'),
  stages: {
    preparing: tr('Przygotowanie aktualizacji…'),
    closing: tr('Zamykanie ajzakomatora…'),
    installing: tr('Instalowanie nowej wersji…'),
    launching: tr('Uruchamianie ajzakomatora…'),
  },
  done: tr('Gotowe - uruchamiam nową wersję'),
  slow: tr('Aktualizacja trwa dłużej niż zwykle'),
  slowHint: tr('Możesz uruchomić ajzakomator ręcznie.'),
  open: tr('Uruchom ajzakomator'),
  close: tr('Zamknij'),
  waitingClose: tr('Czekam na zamknięcie ajzakomatora…'),
  waitingInstaller: tr('Czekam na instalator. Jeśli Windows poprosi o zgodę, potwierdź ją.'),
  installingLong: tr('Instalacja trwa dłużej niż zwykle - to może jeszcze chwilę potrwać…'),
  background: tr('Aktualizacja trwa dalej w tle'),
});

const send = (channel: string, ...args: unknown[]) => { safeSend(win, channel, ...args); };

const controller = new StateController(state, (snapshot) => {
  for (const project of state.projects) for (const tab of project.tabs) for (const cell of tab.cells) {
    if (cell.role && !findCell(snapshot.state, cell.id)?.cell.role) mcp.revokeCell(cell.id);
  }
  state = snapshot.state;
  const key = `${state.settings.showAiUsage}:${state.settings.usageIntervalMinutes}`;
  if (key !== usageKey) { usageKey = key; usage.reschedule(); }
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
  win.once('ready-to-show', () => {
    if (process.env.MC_OFFSCREEN) win?.showInactive(); else win?.show();
    void signalUpdateReady();
    clearGateFailureIfUpdated();
  });
  const created = win;
  // Async callbacks outlive the native window (shutdown, update hand-over); they must see "no window", not a destroyed one.
  created.once('closed', () => { if (win === created) win = null; });
  win.on('minimize', () => usage.setActive(false));
  win.on('hide', () => usage.setActive(false));
  win.on('restore', () => usage.setActive(true));
  win.on('show', () => usage.setActive(true));
  if (!app.isPackaged) win.webContents.on('console-message', (e) => e.level !== 'debug' && console.log('[renderer]', e.level, e.message));
  win.webContents.on('did-finish-load', () => { if (isLive(win)) { ptyHost.connectRenderer(win.webContents); void pushSwapPending(); } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

// ── pty host ────────────────────────────────────────────────────────────────

ptyHost.on('message', (m: HostToMain) => {
  if ('id' in m && m.id.startsWith('auth:')) return; // login windows are not cells
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
  login.failActive('spawn');
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
  if (!findCell(state, cellId)) return; // stale or foreign id
  automation.statuses.set(cellId, event === 'prompt' || event === 'busy' || event === 'stopbg' ? 'working' : event === 'stop' ? 'ready' : 'needs_attention');
  send('cell:hook', cellId, event);
});

// The user switched conversation inside a running Claude (/resume, /clear): follow it so a restart
// resumes the right one. Events for cells that are not alive are dropped (late hook of an old process).
hooks.on('session', (cellId: string, sessionId: string) => {
  const found = findCell(state, cellId);
  if (!shouldUpdateCellSession({
    known: !!found,
    isClaude: !!found && getProfile(state, found.cell.profileId).cli === 'claude',
    alive: alive.has(cellId),
    currentId: found?.cell.session?.id,
    reportedId: sessionId,
  })) return;
  send('cell:session', cellId, followedSession(sessionId));
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

/** Opens the dialog on the main window while it exists, free-standing otherwise. */
const showOpen = (options: OpenDialogOptions) => (isLive(win) ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await showOpen({ properties: ['openDirectory'], title: tr('Wybierz folder projektu') });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('sound:pick', async () => {
  const r = await showOpen({
    properties: ['openFile'],
    title: tr('Wybierz plik dźwiękowy'),
    filters: [{ name: tr('Pliki dźwiękowe'), extensions: [...SOUND_EXTENSIONS] }],
  });
  return r.canceled || !isSoundFile(r.filePaths[0]) ? null : r.filePaths[0];
});
// The path is never taken from the renderer: only the saved setting (set from the dialog result) is read.
ipcMain.handle('sound:load', (_e, knownKey?: unknown) =>
  loadSoundFile(state.settings.waitingSoundFile, typeof knownKey === 'string' ? knownKey : undefined));
ipcMain.on('sound:beep', () => shell.beep());
ipcMain.handle('fs:exists',(_e, p: string) => existsSync(p));
ipcMain.handle('fs:listProjectDirectory', (_e, projectId: string, path: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? listProjectDirectory(project.path, path) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:listProjectDirectories', (_e, projectId: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? listProjectDirectories(project.path) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:searchProject', (_e, projectId: string, options: SearchOptions) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? searchProject(project.path, options) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:replaceInProject', (_e, projectId: string, request: ReplaceRequest) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? replaceInProject(project.path, request) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:readProjectFile', (_e, projectId: string, path: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? readProjectFile(project.path, path) : { kind: 'error', message: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:writeProjectFile', (_e, projectId: string, path: string, text: string, expectedText: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? writeProjectFile(project.path, path, text, expectedText) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('sessions:list', (_e, projectPath: string) => listSessionsAsync(homedir(), projectPath));
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
    withLiveWindow(win, (w) => {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    });
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
const changelog = createChangelog({
  cacheFile: join(DATA_DIR, 'changelog.json'),
  fetchJson: async (url) => {
    const response = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ajzakomator' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    return response.json();
  },
});
ipcMain.handle('changelog:get', (_e, force: boolean) => changelog.get(force));
ipcMain.handle('usage:get', () => usage.getState());
ipcMain.handle('usage:refresh', () => usage.refresh(true));
ipcMain.handle('auth:start', (_e, request: unknown) => {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return { ok: false, error: 'invalid request' };
  return loginBlock(guardDeps, request).then((block) => (block ? { ok: false as const, error: block } : login.start(request as LoginRequest)));
});
ipcMain.on('auth:cancel', (_e, id: unknown) => { if (typeof id === 'string') login.cancel(id); });
ipcMain.handle('accounts:remove', (_e, id: unknown) => handleRemoveAccount({
  ...guardDeps,
  cancelLogin: (accountId) => login.cancelFor(accountId),
  remove: (accountId) => accounts.remove(accountId),
  onRemoved: () => { void usage.refresh(true, true); },
}, id));
ipcMain.handle('accounts:makeMain', async (_e, id: unknown) => {
  const result = await handleMakeMain({
    loginActive: () => login.isActive(),
    swap: (accountId) => swapMainAccount(swapDeps(), accountId),
    onSwapped: () => { void usage.refresh(true, true); },
  }, id);
  void pushSwapPending();
  return result;
});
ipcMain.handle('accounts:swapPending', () => hasPendingSwap(swapDeps()).catch(() => true));
/** The user confirmed that the emergency copy of an unresolved swap may be deleted for good. */
ipcMain.handle('accounts:clearSwapPending', async () => {
  const cleared = await clearPendingSwap(swapDeps());
  void pushSwapPending();
  return { ok: cleared };
});
usage.onChange((snapshot) => send('usage:state', snapshot));
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

/** A launch that arrived while this process was winding down; the new instance already exited, so it is repeated at exit. */
let relaunchRequested = false;

app.on('second-instance', () => {
  // Also fires while this process is winding down after its window closed; then there is nothing to focus.
  const focused = withLiveWindow(win, (w) => {
    if (w.isMinimized()) w.restore();
    w.focus();
    return true;
  });
  if (!focused && quitting) relaunchRequested = true;
});

/** True while the startup update check owns the screen: closing its window must not quit the app. */
let gating = false;
const GATE_FILE = join(DATA_DIR, 'update-gate.json');
const readGateFailure = () => { try { return parseFailure(JSON.parse(readFileSync(GATE_FILE, 'utf8'))); } catch { return undefined; } };

/** If the installer has not quit the app this long after the hand-over, the app starts normally instead of hanging unseen. */
const HANDOFF_QUIT_WATCHDOG_MS = 15 * 1000;
let handoffWatchdog: ReturnType<typeof setTimeout> | undefined;

const writeGateRecord = (version: string) => { try { writeFileSync(GATE_FILE, JSON.stringify({ version, at: Date.now() })); } catch { /* best effort */ } };
const recordUpdateFailure = (version: string) => { writeGateRecord(version); blockUpdateVersion(version); };

/** The record of an attempt or failure ends once the version it targeted (or a newer one) is actually running. */
function clearGateFailureIfUpdated(): void {
  const record = readGateFailure();
  if (record && compareVersions(app.getVersion(), record.version) >= 0) { try { rmSync(GATE_FILE, { force: true }); } catch { /* retried on next start */ } }
}

/** Runs the updater before the main window exists; resolves true when the installer took over and the app must not start. */
async function runUpdateGate(): Promise<boolean> {
  let window: ReturnType<typeof createGateWindow> | undefined;
  try {
    const failure = readGateFailure();
    const recent = isRecentFailure(failure, Date.now());
    if (failure && recent && state.settings.updateMode !== 'manual' && compareVersions(failure.version, app.getVersion()) > 0) blockUpdateVersion(failure.version);
    if (!shouldGateOnStartup({
      platform: process.platform, packaged: updatesEnabled(), portable: isPortableBuild(),
      mode: state.settings.updateMode, recentFailure: recent,
    })) return false;
    const version = app.getVersion();
    window = createGateWindow({
      checking: tr('Sprawdzanie aktualizacji…'),
      downloading: tr('Pobieranie aktualizacji…'),
      updating: (next) => tr('Aktualizacja do wersji {version}', { version: next }),
      hint: tr('Nie wyłączaj komputera. ajzakomator uruchomi się automatycznie.'),
      preparing: tr('Przygotowanie aktualizacji…'),
      failed: tr('Aktualizacja nie powiodła się - uruchamiam obecną wersję'),
      close: tr('Zamknij'),
      available: (next) => tr('Dostępna nowa wersja {version}', { version: next }),
      askMessage: tr('Zainstalować ją teraz?'),
      askHint: tr('„Później” uruchamia obecną wersję. Zainstalujesz ją przyciskiem w stopce.'),
      install: tr('Zainstaluj teraz'),
      later: tr('Później'),
    }, version);
    gating = true;
    let handedOver = '';
    const result = await runStartupGate({
      check: startupCheck, abandonCheck: abandonStartupCheck, download: startupDownload,
      handoff: (next, hide) => { handedOver = next; return startupHandoff(hide); },
      show: window.show, hide: window.hide, onCancel: window.onCancel, onInstall: window.onInstall,
      skipVersion: failure?.version,
      markAttempt: writeGateRecord, recordFailure: recordUpdateFailure,
    });
    if (result !== 'installing') { gating = false; return false; }
    // After a hand-over `gating` stays on: the app is quitting for the installer and must not wind anything down.
    const armedAt = Date.now();
    const watch = () => {
      // The update window still supervising means the installer is only slow (late administrator prompt): keep waiting.
      if (handoffWatchdogAction(updateInstalling(START_BLOCK_MS), Date.now() - armedAt) === 'wait') {
        handoffWatchdog = setTimeout(watch, HANDOFF_QUIT_WATCHDOG_MS / 3);
        return;
      }
      console.error('the installer did not quit the app, starting normally');
      recordUpdateFailure(handedOver);
      void abortUpdateWindow();
      gating = false;
      void startMainApp().catch((error) => console.error('startup failed', error));
    };
    handoffWatchdog = setTimeout(watch, HANDOFF_QUIT_WATCHDOG_MS);
    return true;
  } catch (error) {
    console.error('startup update gate failed', error);
    try { window?.hide(); } catch { /* already gone */ }
    gating = false;
    return false;
  }
}

async function startMainApp(): Promise<void> {
  await hooks.start();
  try { await mcp.start(); } catch (error) { mcpError = error instanceof Error ? error.message : String(error); }
  ptyHost.start();
  // An interrupted main-account swap is repaired (or reported as pending) before any window or IPC call can start another.
  try { await recoverInterruptedSwap(swapDeps()); } catch { /* the journal stays and the next start retries */ }
  createWindow();
  usage.start();
  scheduleUpdateCleanup();
}

app.whenReady().then(async () => {
  if (superseded) return;
  // No default menu: its Ctrl+W / Ctrl+R accelerators would close or reload the window.
  Menu.setApplicationMenu(null);
  initUpdater((s) => send('update:state', s), { strings: updateStrings });
  if (await runUpdateGate()) return;
  await startMainApp();
}).catch((error) => console.error('startup failed', error));

let quitting = false;

const updaterLog = createUpdaterLogger(join(DATA_DIR, 'updater.log'));
/** Logging must never throw out of a crash or shutdown handler. */
const crashLog = {
  error: (message: string) => { try { updaterLog.error(message); } catch { /* nothing else to do */ } },
  warn: (message: string) => { try { updaterLog.warn(message); } catch { /* nothing else to do */ } },
};
const allowErrorDialog = createDialogLimiter();
// Registering a handler replaces Electron's blocking native error dialog; a dialog open during shutdown
// would keep the process alive while the installer waits for it to exit.
process.on('uncaughtException', (error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  const decision = decideUncaught(error, quitting || gating ? 'quiet' : 'running');
  crashLog.error(`uncaught exception (${decision}): ${detail}`);
  if (decision !== 'show' || !allowErrorDialog(Date.now())) return;
  void dialog.showMessageBox({ type: 'error', title: 'ajzakomator', message: tr('Wystąpił nieoczekiwany błąd w głównym procesie'), detail }).catch(() => {});
});

/** Ends the process; a launch that was swallowed during the wind-down is repeated, unless an update took over. */
function exitNow(): void {
  if (shouldRelaunchAfterQuit(relaunchRequested, updateHandoffStarted())) { try { app.relaunch(); } catch { /* nothing else to do */ } }
  app.exit(0);
}

app.on('before-quit', (e) => {
  clearTimeout(handoffWatchdog);
  // The installer took over before anything was started, so there is nothing to wind down.
  if (quitting || gating || superseded) return;
  e.preventDefault();
  quitting = true;
  // However the wind-down goes (stuck terminals), the process must end: a running installer waits for it.
  const shutdownLimit = setTimeout(() => { crashLog.warn('shutdown overran its limit, exiting'); ptyHost.forceKill(); exitNow(); }, SHUTDOWN_HARD_LIMIT_MS);
  usage.stop();
  login.dispose();
  send('app:before-quit');
  // Give the renderer a moment to push its final state, then wind down terminals cleanly.
  setTimeout(async () => {
    try {
      saver.flush();
    } catch (err) {
      console.error('state save failed', err);
    }
    try {
      await ptyHost.shutdown();
      await mcp.stop();
      hooks.stop();
    } catch (err) {
      crashLog.error(`shutdown failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    clearTimeout(shutdownLimit);
    exitNow();
  }, 150);
});
app.on('window-all-closed', () => { if (!gating) app.quit(); });
