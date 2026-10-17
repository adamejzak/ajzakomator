import { createHash } from 'crypto';
import { execFile, spawn, spawnSync } from 'child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, safeStorage, shell, type OpenDialogOptions } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, hostname } from 'os';
import { isAbsolute, join } from 'path';
import { stat } from 'fs/promises';
import type { SpawnCellRequest } from '../preload/api';
import { cleanEnv } from '../shared/env';
import type { HostToMain } from '../shared/ipc';
import { buildLaunchCommand } from '../shared/profiles';
import type { AppState, Worktree } from '../shared/types';
import { appPlatform } from '../shared/platform';
import { detectLanguage } from '../shared/languages';
import { translate, type MessageKey, type MessageParams } from '../shared/i18n';
import { HookServer } from './hooks';
import { applyDockIcon, windowIcon } from './appIcon';
import { LARGE_VIEW_BYTES, listProjectDirectories, listProjectDirectory, listProjectDirectoryBatch, readProjectFile, writeProjectFile } from './files';
import { registerFileOpsIpc } from './filesIpc';
import { registerGitIpc } from './gitIpc';
import { replaceInProject, searchProject } from './search';
import type { ReplaceRequest, SearchOptions } from '../shared/search';
import { PtyHostClient } from './ptyHostClient';
import { claudeProjectDirName, findRecentCodexSession, listSessionsAsync } from './sessions';
import { createSaver, loadState } from './store';
import { updateHandoverCommitted, blockUpdateVersion, canInstallNow, checkForUpdates, getUpdateState, handOver, initUpdater, isPortableBuild, isUpdateDownloaded, onUpdateTargetChange, previousMacUpdate, recheckUpdate, signalMacUpdateReady, updateHandoffStarted, updateTarget, RELEASES_URL, startupCheck, startupDownload, updatesEnabled } from './updater';
import { createUpdateUiGuard } from './updateUiGuard';
import { compareVersions, gateSkipVersion, isActiveFailure, parseFailure, runInstallWindow, runStartupGate, shouldGateOnStartup } from './startupGate';
import { createGateWindow, type GateTexts } from './gateWindow';
import { createDialogLimiter, decideUncaught, handoffWatchdogAction, isFromWindow, isLive, safeSend, shouldRelaunchAfterQuit, SHUTDOWN_HARD_LIMIT_MS, withLiveWindow } from './safeWindow';
import { createUpdaterLogger } from './updaterLog';
import { START_BLOCK_MS, abortUpdateWindow, scheduleUpdateCleanup, signalUpdateReady, updateInstalling, waitForUpdateWindowGone } from './updateSplash';
import { createChangelog } from './changelog';
import { refreshClaudeProfile, type RefreshOutcome } from './accounts/refresh';
import { createRefreshLimits } from './accounts/refreshLimits';
import { createTokenFetch } from './accounts/tokenTransport';
import { handleMakeMain } from './accounts/makeMain';
import { AccountsStore } from './accounts/store';
import { dismissAccountNotice, gateFamilyRefresh, gateProfileRefresh, handleAdoptCopy, handleRemoveAccount, loginBlock } from './accounts/guards';
import { registerAccountIpc } from './accountsIpc';
import { createSecretClipboard } from '../shared/sshClipboard';
import { clearPendingSwap, hasPendingSwap, isSwapRunning, isSwapUnresolved, recoverInterruptedSwap, swapPaths, type SwapDeps } from './accounts/swap';
import {
  activateAccount, activationJournalPending, checkActivationTarget, clearPendingActivation, isActivationRecoveryPending, recoverActivationWithRetry,
  recoverInterruptedActivation, startActivationRecoveryRetry, type ActivateDeps,
} from './accounts/activate';
import { backupLiveBeforeLogin, reconcileLive, reconcileWhenIdle, resyncOutgoingWhenIdle, type ReconcileDeps } from './accounts/reconcile';
import { resyncActiveBackup } from './accounts/resync';
import { accountsPanelInfo, claudeRefs } from './accounts/refs';
import { cswapRosterPath, readCswapRoster, type CswapRoster } from './accounts/cswap';
import { readManagedIdentity } from './accounts/identity';
import { migrateAccounts, type MigrationDeps } from './accounts/migrate';
import { LoginManager } from './auth/login';
import { identityRewritten, restoreProfile, snapshotProfile } from './auth/profileSnapshot';
import { custodyOf, identityFields, isAccountId, type AccountIdentity, type LoginRequest } from '../shared/accounts';
import { claudeCredentialsStamp, profileSource, readClaudeCredentials, readClaudeIdentity, readCodexCredentials, readLiveClaudeIdentity, systemCredentialSource } from './usage/credentials';
import { fetchClaude, fetchCodex, type FetcherDeps } from './usage/fetchers';
import { UsageService } from './usage/service';
import { MAIN_ACCOUNTS } from '../shared/usage';
import type { UpdateStrings } from '../shared/updateProgress';
import { createWorktree, isGitRepo, removeWorktree } from './worktree';
import { StateController } from './stateController';
import { SshCoordinator } from './ssh/coordinator';
import { createSshHandlers, readKeyFileFromDisk, registerSshIpc } from './ssh/ipc';
import { KeyDrafts } from './ssh/keys';
import { KnownHostsStore } from './ssh/knownHosts';
import { writePrivateFile } from './ssh/files';
import { electronCipher, SshVault } from './ssh/vault';
import { AutomationService } from './automation';
import { UnimuxMcpServer } from './mcp';
import { queueCodexMessage } from './agentDelivery';
import { CliDetector } from './cliDetect';
import { createCliHandlers, createInstallHandlers } from './cliIpc';
import { InstallManager } from './cliInstall';
import { killProcessTree, runProgram, systemCliDeps } from './cliSystem';
import { INSTALL_PTY_PREFIX } from '../shared/cliInstall';
import { cliForProfile, CLI_NAMES, isCliId, missingCli, resolveExecFile, spawnDecision, type CliId, type CliStatus } from '../shared/cliStatus';
import { automationSchemas, type AutomationOperation, type McpInfo } from '../shared/automation';
import type { StateEdit } from '../shared/stateEdits';
import { stateChange } from '../shared/statePatch';
import { findCell, getProfile } from '../shared/state';
import { resumesConversation } from '../shared/ssh';
import { automationHintForHook, automationStatusFor } from '../shared/runtimeStatus';
import { followedSession, shouldUpdateCellSession } from '../shared/sessionTrack';
import type { CodexNotice } from '../shared/codexHooks';
import { isSoundFile, SOUND_EXTENSIONS } from '../shared/sound';
import { loadEventSound } from './alertSound';
import { notificationOptions } from './notifyOptions';
import { migrateDataDir } from './dataDirMigration';
import { updateWindowAlive } from './updateRuntime';

// Moves %APPDATA%\ajzakomator (macOS: ~/Library/Application Support/ajzakomator) to `unimux` once, leaving a link behind, before
// anything else touches the data directory. While the previous version's update window still supervises an install the old
// directory stays in place for this run (its files are open and that window polls paths inside it).
const DATA_DIR = migrateDataDir({
  appData: app.getPath('appData'),
  platform: process.platform,
  env: process.env,
  packaged: app.isPackaged,
  busy: (legacy) => updateWindowAlive(join(legacy, 'update')),
  log: (message) => console.warn(message),
}).dataDir;
// Carry over state from the app's earliest name (MultiCoding) into the final data directory.
const LEGACY_STATE = join(app.getPath('appData'), 'MultiCoding', 'state.json');
if (!process.env.MC_DATA_DIR && !existsSync(join(DATA_DIR, 'state.json')) && existsSync(LEGACY_STATE)) {
  mkdirSync(DATA_DIR, { recursive: true });
  copyFileSync(LEGACY_STATE, join(DATA_DIR, 'state.json'));
}
const HOOKS_DIR = join(DATA_DIR, 'hooks');
const PROMPTS_DIR = join(DATA_DIR, 'prompts');
const MCP_DIR = join(DATA_DIR, 'mcp');
app.setPath('userData', DATA_DIR);
// Matches build.appId, which the installer also stamps on the shortcuts. A run from the repository (npm run dev, a clone of the
// project) gets its own identity: it must never share the taskbar entry (and its icon) with the installed app.
const APP_USER_MODEL_ID = app.isPackaged ? 'com.unimux.app' : 'com.unimux.app.dev';
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

if (process.env.MC_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.MC_DEBUG_PORT);
// Module code keeps running after app.quit(), so every later step checks `superseded` instead of assuming the exit is immediate.
let superseded = !process.env.MC_DATA_DIR && !app.requestSingleInstanceLock();
// The installer is replacing this build's files right now (the update window is showing it); starting would crash.
if (!superseded && process.platform === 'win32' && app.isPackaged && !process.env.MC_DATA_DIR && updateInstalling(START_BLOCK_MS)) superseded = true;
if (superseded) app.exit(0);

let win: BrowserWindow | null = null;
/** The sender check of every IPC channel that changes accounts, logins, usage, SSH data or the secret clipboard (R9). */
const fromAppWindow = (event: { sender: unknown; senderFrame?: unknown }): boolean => isFromWindow(win, event);
/** SSH sessions: created after app.whenReady() (safeStorage needs it), before the window (startSsh). */
let ssh: SshCoordinator | null = null;
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
  // The usage endpoint counts its limit per client: the app reads as itself, never as Claude Code.
  userAgent: `unimux/${app.getVersion()}`,
};
/** Token renewals: our own headers (no Chromium fingerprint, no Claude Code User-Agent), a persisted backoff after HTTP 429, system proxy only as a fallback. */
const refreshLimits = createRefreshLimits(join(DATA_DIR, 'refresh-limits.json'));
const tokenFetch = createTokenFetch(usageDeps.fetch);
const renewProfile = (dir: string) => refreshClaudeProfile(dir, { fetch: tokenFetch, now: usageDeps.now, limits: refreshLimits, userAgent: `unimux/${app.getVersion()}`, tokenUrl: app.isPackaged ? undefined : process.env.MC_USAGE_CLAUDE_TOKEN_URL });
const accounts = new AccountsStore(join(DATA_DIR, 'accounts'));
/** cswap's roster, read before every poll (R6); `{ present: false }` without cswap. */
let cswapRoster: CswapRoster = { present: false };
/** How long a poll waits for the retry of failed profile restores before it reads the accounts. */
const PARKED_RESTORE_WAIT_MS = 2_000;
const usage = new UsageService({
  accounts: () => [
    ...claudeRefs({ records: accounts.list(), dirOf: (id) => accounts.dirOf(id), live: accounts.live(), cswap: cswapRoster, platform: process.platform }),
    MAIN_ACCOUNTS[1],
  ],
  fetchAccount: (ref) => (ref.provider === 'claude' ? fetchClaude(usageDeps, ref) : fetchCodex(usageDeps)),
  cacheFile: join(DATA_DIR, 'usage-cache.json'),
  credentialsStamp: (ref) => (ref.provider === 'claude' && !ref.configDir ? claudeCredentialsStamp(usageDeps.credentials) : Promise.resolve(null)),
  enabled: () => state.settings.showAiUsage,
  intervalMs: () => state.settings.usageIntervalMinutes * 60_000,
  // Every poll first looks at who is signed in to Claude Code (cswap switch, /login); never while a swap or a login runs.
  // The swap slot is held meanwhile, so a "Set as main" or a recovery can never interleave with the role changes.
  beforeRun: async () => {
    cswapRoster = await readCswapRoster(cswapRosterPath(homedir(), process.env, process.platform));
    // An activation whose recovery found Claude Code's locks busy is retried first; the live login is not reconciled while
    // its journal exists (the live files may be half written).
    if (isActivationRecoveryPending()) await retryActivationRecovery();
    // A re-login whose restore failed earlier is tried again (the card stays set aside until it works). The poll waits for it
    // briefly only: a restore waiting for Claude Code's locks goes on by itself instead of delaying every account's read.
    await login.retryParkedRestores(PARKED_RESTORE_WAIT_MS).catch(() => undefined);
    // During a main login the roles stay as they are, but the outgoing live login keeps being backed up.
    if (login.isMainActive()) await resyncOutgoingWhenIdle(liveGuard(), reconcileDeps()).catch(() => null);
    else await reconcileIdle();
  },
  watchLive: true,
  notices: () => accounts.notices(),
  // An unreadable accounts.json is explained in the panel; set-aside cards are listed with what to do about them.
  accountsInfo: () => (accounts.readOnly()
    ? { accountsReadOnly: join(DATA_DIR, 'accounts', 'accounts.json') }
    : accountsPanelInfo(accounts.list(), login.parkedIds())),
  liveEmail: () => accounts.live()?.email,
});
/** Finds Claude Code / Codex even when the app's own PATH lacks them (GUI launch on macOS, installer run after start on Windows). */
const cliDetector = new CliDetector(systemCliDeps({
  disableRegistry: !app.isPackaged && process.env.MC_CLI_NO_REGISTRY === '1',
  shell: () => state.settings.shell,
  // Unpackaged builds only: a script dot-sourced instead of the real PowerShell profile (UI checks must not run the user's profile).
  probeProfile: !app.isPackaged ? process.env.MC_CLI_PROBE_PROFILE || undefined : undefined,
}));
/** How long a spawn may wait for a detection before it proceeds anyway (unknown never blocks). */
const CLI_WAIT_MS = 7000;
const execText = async (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> => {
  // `claude` / `codex` run from where they were detected, with a PATH that has their directory.
  const cli = isCliId(command) ? command : undefined;
  const status = cli ? await cliDetector.get(cli, { waitMs: CLI_WAIT_MS }).catch(() => undefined) : undefined;
  const file = resolveExecFile(command, status, process.platform);
  const runEnv = await cliDetector.applyEnv(cleanEnv(env), cli);
  return new Promise((resolve) => {
    execFile(file, args, { env: runEnv, timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }, (error, stdout) => resolve(error ? null : stdout));
  });
};
/** Bumped when a cell is killed, so a spawn that was waiting for the detection does not resurrect it. */
const killCount = new Map<string, number>();
const noteKill = (id: string) => killCount.set(id, (killCount.get(id) ?? 0) + 1);
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
  resetCredentialCache: () => usageDeps.credentials.resetKeychainCache?.(),
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
  knownIdentities: async () => {
    // An unreadable live login must not hide the saved accounts from the duplicate check.
    const live = await readLiveIdentity().catch(() => null);
    return [
      ...(live ? [{ ...live, live: true }] : []),
      ...accounts.list().filter((a) => custodyOf(a) !== 'quarantined').map((a) => ({ ...identityFields(a), recordId: a.id })),
    ];
  },
  snapshotProfile,
  restoreProfile,
  identityRewritten,
  // The live login is backed up into its record before `claude auth login` replaces it (nothing is dropped); refused
  // (the login does not start) unless that backup is current.
  beforeMainLogin: () => backupLiveBeforeLogin(liveGuard(), reconcileDeps(), {
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ownChange: ownLoginChange,
    ownChangeApplied: () => { ownLoginChange = false; },
  }),
  emit: (s) => send('auth:state', s),
  onChanged: (change) => {
    if (change.ownChange) ownLoginChange = true;
    // The account the login was about is read at once, whatever its read spacing (`claude:main` = the live Claude card).
    const subject = change.provider === 'codex' ? 'codex:main' : change.recordId ? `claude:${change.recordId}` : 'claude:main';
    void (async () => {
      if (change.ownChange) await reconcileIdle().catch(() => false);
      void usage.refresh(true, true, subject);
    })();
  },
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
  // The 0.9.0 exchange is no longer wired; should it ever run, it renews only through the one family rule too.
  refresh: (dir) => familyRenew(dir),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
/** "Set as main" (0.9.1): renewals inside go through gateFamilyRefresh with the roster read for that activation. */
const activateDeps = (): ActivateDeps => ({
  home: homedir(), env: process.env, platform: process.platform, store: accounts,
  backupDir: join(DATA_DIR, 'accounts', 'swap-backup'),
  now: () => Date.now(),
  refresh: (dir) => renewProfile(dir),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  cswap: () => readCswapRoster(cswapRosterPath(homedir(), process.env, process.platform)),
});
const guardDeps = { swapRunning: isSwapRunning, swapPending: () => hasPendingSwap(swapDeps()), swapPendingNow: () => isSwapUnresolved() || isActivationRecoveryPending(), readOnly: () => accounts.readOnly() };
/** The live Claude login's identity (`~/.claude.json`), null when nobody is signed in; throws when the file cannot be read or parsed. */
const readLiveIdentity = () => readLiveClaudeIdentity(usageDeps.credentials);
/** One more try of a version-2 recovery that found Claude Code's locks busy (from the polls and from its own timer). */
async function retryActivationRecovery(): Promise<void> {
  const recovered = await recoverInterruptedActivation(activateDeps()).catch(() => 'manual' as const);
  if (recovered !== 'locked') void pushSwapPending();
}
const migrationDeps = (): MigrationDeps => ({
  store: accounts,
  readProfileIdentity: (dir) => readClaudeIdentity(profileSource(usageDeps.credentials, dir)),
  readLiveIdentity,
  readExpiry: async (dir) => (await readClaudeCredentials(profileSource(usageDeps.credentials, dir)))?.expiresAt,
  now: () => Date.now(),
});
/** Live-file signatures of the previous reconcile per record: a backup is only taken of files that read the same twice. */
const resyncSeen = new Map<string, string>();
const reconcileDeps = (): ReconcileDeps => {
  const paths = swapPaths({ home: homedir(), env: process.env });
  return {
    store: accounts,
    readLiveIdentity,
    // macOS keeps the live login in the Keychain: there is no file to back up.
    ...(paths && process.platform !== 'darwin'
      ? { resync: (recordId: string, identity: AccountIdentity) => resyncActiveBackup({ paths, store: accounts, seen: resyncSeen, delay: (ms) => new Promise((r) => setTimeout(r, ms)) }, recordId, identity) }
      : {}),
    now: () => Date.now(),
  };
};
/**
 * Set by a finished main Claude login until a reconcile has run: the record that left the live login was backed up by the
 * app (beforeMainLogin), so it becomes `app`, not `foreign` with a "switched out" notice. Kept until a reconcile actually
 * runs, so a poll that wins the swap slot first applies it too.
 */
let ownLoginChange = false;
/** What stops any look at the live login: an unresolved swap or an interrupted activation's journal (the slot is checked too). */
const liveGuard = () => ({ swapUnresolved: isSwapUnresolved, journalPending: () => activationJournalPending(activateDeps()) });
/** Reconciles the live login holding the swap slot; skipped while a swap, a login or an activation journal is pending. */
function reconcileIdle(): Promise<boolean> {
  return reconcileWhenIdle({ ...liveGuard(), loginActive: () => login.isActive() }, async () => {
    // The own change is used by this one reconcile, also when it fails halfway.
    const ownChange = ownLoginChange;
    ownLoginChange = false;
    await reconcileLive(reconcileDeps(), ownChange ? { ownChange } : {});
  });
}
/** Tells the renderer whether an unresolved swap blocks further swaps. */
async function pushSwapPending(): Promise<void> {
  send('accounts:swapPending', await hasPendingSwap(swapDeps()).catch(() => true));
}
// Background refreshes never write into a managed profile while a swap runs or is unresolved.
// Only profiles whose token family lives nowhere else are renewed (renewRule, R6): never the live login, a switched-out
// record or a copy of the live family that cswap also holds.
const refreshBlocked: RefreshOutcome = { kind: 'transient', detail: { reason: 'blocked' } };
// Nor a card being signed in again or whose restore runs or failed: its files must stay the snapshot's (or are another account's).
const familyRenew = gateFamilyRefresh(accounts, () => cswapRoster, (dir) => (login.holdsProfile(dir) ? Promise.resolve(refreshBlocked) : renewProfile(dir)), refreshBlocked);
usageDeps.refreshClaude = gateProfileRefresh<RefreshOutcome>(guardDeps, familyRenew, refreshBlocked);
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
  hint: tr('Nie wyłączaj komputera. unimux uruchomi się automatycznie.'),
  stages: {
    preparing: tr('Przygotowanie aktualizacji…'),
    closing: tr('Zamykanie unimux…'),
    installing: tr('Instalowanie nowej wersji…'),
    launching: tr('Uruchamianie unimux…'),
  },
  done: tr('Gotowe - uruchamiam nową wersję'),
  slow: tr('Aktualizacja trwa dłużej niż zwykle'),
  slowHint: tr('Możesz uruchomić unimux ręcznie.'),
  open: tr('Uruchom unimux'),
  close: tr('Zamknij'),
  waitingClose: tr('Czekam na zamknięcie unimux…'),
  waitingInstaller: tr('Czekam na instalator. Jeśli Windows poprosi o zgodę, potwierdź ją.'),
  installingLong: tr('Instalacja trwa dłużej niż zwykle - to może jeszcze chwilę potrwać…'),
  background: tr('Aktualizacja trwa dalej w tle'),
});

const send = (channel: string, ...args: unknown[]) => { safeSend(win, channel, ...args); };
cliDetector.onChange((map) => send('cli:changed', map));
/** Guided install of the agent CLIs in a visible terminal (`install:` ptys are not cells). */
const install = new InstallManager({
  platform: process.platform,
  home: homedir(),
  shell: () => state.settings.shell,
  env: () => process.env,
  exec: runProgram,
  detector: cliDetector,
  spawnPty: (spec) => ptyHost.spawn({ id: spec.id, cwd: homedir(), cols: 100, rows: 28, env: spec.env, shell: state.settings.shell, command: spec.command, tap: true }),
  killPty: (id) => ptyHost.kill(id),
  killTree: killProcessTree,
  emit: (installState) => send('install:state', installState),
  // Test hook of unpackaged builds: a harmless local script instead of the vendor's installer.
  commandOverride: app.isPackaged ? undefined : () => process.env.MC_INSTALL_COMMAND_OVERRIDE || undefined,
});

const controller = new StateController(state, (snapshot) => {
  for (const project of state.projects) for (const tab of project.tabs) for (const cell of tab.cells) {
    if (cell.role && !findCell(snapshot.state, cell.id)?.cell.role) mcp.revokeCell(cell.id);
  }
  const previous = state;
  state = snapshot.state;
  ssh?.stateChanged(state);
  const key = `${state.settings.showAiUsage}:${state.settings.usageIntervalMinutes}`;
  if (key !== usageKey) { usageKey = key; usage.reschedule(); }
  saver.save(state);
  send('state:changed', stateChange(previous, snapshot));
});
const automation = new AutomationService(controller, {
  createWorktree,
  removeWorktree: (path, wt) => removeWorktree(path, wt, true),
  startCells: (ids) => send('automation:start-cells', ids),
  missingCli: (profileId) => {
    const profile = state.profiles.find((p) => p.id === profileId);
    return profile ? missingCli(profile, cliDetector.snapshot()) ?? undefined : undefined;
  },
  stopCells: async (ids) => {
    for (const id of ids) { noteKill(id); ssh?.killed(id); mcp.revokeCell(id); verifiedCodex.delete(id); alive.delete(id); automation.statuses.set(id, 'exited'); }
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
    const result = await spawnRequest({ cellId, cwd, profile, mode: 'resume', sessionId: session.id, sessionConfirmed: true, cols: 100, rows: 30 });
    if (result.ok) send('cell:restarted', cellId);
    return { restarted: result.ok, reason: result.ok ? undefined : result.error };
  },
  deliver: async (cellId, text) => {
    const found = findCell(state, cellId);
    if (!found || !alive.has(cellId)) throw new Error('Agent is not running. The item is available in its MCP inbox.');
    if (getProfile(state, found.cell.profileId).cli !== 'codex') throw new Error('Available in the MCP inbox. Use Paste to insert it into this agent without submitting.');
    const sessionId = verifiedCodex.get(cellId);
    if (!sessionId || found.cell.session?.id !== sessionId) throw new Error('Session identity is not verified. The item is available in the MCP inbox.');
    const codex = await cliDetector.get('codex', { waitMs: CLI_WAIT_MS }).catch(() => undefined);
    await queueCodexMessage(sessionId, text, {
      command: codex?.state === 'found' ? codex.path : undefined,
      env: await cliDetector.applyEnv(cleanEnv(process.env), 'codex'),
    });
  },
});
const mcp = new UnimuxMcpServer(automation);

function createWindow(): void {
  win = new BrowserWindow({
    width: process.env.MC_OFFSCREEN ? 1100 : 1600,
    height: process.env.MC_OFFSCREEN ? 700 : 1000,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#0d0d0d',
    title: 'unimux',
    icon: windowIcon(),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: '#0d0d0d', symbolColor: '#8a8a8a', height: 36 } }),
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true },
    // Off-screen, non-focusable window for automated screenshots (docs).
    ...(process.env.MC_OFFSCREEN ? { x: -6000, y: 0, skipTaskbar: true, focusable: false } : {}),
  });
  // The taskbar button shows our icon (not the Electron one), whatever was cached for this identity before.
  if (process.platform === 'win32') {
    try { win.setAppDetails({ appId: APP_USER_MODEL_ID, appIconPath: app.isPackaged ? process.execPath : windowIcon(), appIconIndex: 0 }); } catch { /* the window icon still applies */ }
  }
  win.once('ready-to-show', () => {
    if (process.env.MC_OFFSCREEN) win?.showInactive(); else win?.show();
    void signalUpdateReady();
    signalMacUpdateReady();
    clearGateFailureIfUpdated();
  });
  const created = win;
  // Async callbacks outlive the native window (shutdown, update hand-over); they must see "no window", not a destroyed one.
  created.once('closed', () => { install.dispose(); if (win === created) win = null; });
  win.on('minimize', () => usage.setActive(false));
  win.on('hide', () => usage.setActive(false));
  win.on('restore', () => usage.setActive(true));
  win.on('show', () => usage.setActive(true));
  if (!app.isPackaged) win.webContents.on('console-message', (e) => e.level !== 'debug' && console.log('[renderer]', e.level, e.message));
  // The install window lives in the renderer: a reload or crash must not leave an invisible install running.
  win.webContents.on('did-start-loading', () => install.dispose());
  win.webContents.on('render-process-gone', () => install.dispose());
  win.webContents.on('did-finish-load', () => { if (isLive(win)) { ptyHost.connectRenderer(win.webContents); void pushSwapPending(); } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

function startSsh(): void {
  const dir = join(DATA_DIR, 'ssh');
  const cipher = electronCipher(safeStorage, process.platform, !app.isPackaged && process.env.MC_SSH_NO_SAFESTORAGE === '1');
  const vault = new SshVault(join(dir, 'vault.json'), cipher);
  const knownHosts = new KnownHostsStore(join(dir, 'known_hosts.json'));
  const vaultChanged = () => send('ssh:vault:changed', vault.info());
  ssh = new SshCoordinator({
    state: () => state, vault, knownHosts,
    host: (m) => ptyHost.sendSsh(m),
    events: { session: (s) => send('ssh:session', s), prompt: (cellId, prompt) => send('ssh:prompt', cellId, prompt), vaultChanged },
    debug: !app.isPackaged && process.env.MC_SSH_DEBUG === '1',
  });
  const coordinator = ssh;
  registerSshIpc(ipcMain, createSshHandlers({
    coordinator, vault, knownHosts, drafts: new KeyDrafts(),
    state: () => state,
    change: (fn) => { controller.change(fn); },
    vaultChanged,
    pickKeyFile: async () => {
      // The default folder is only passed to the dialog; the app never reads ~/.ssh by itself.
      const sshDir = join(homedir(), '.ssh');
      const r = await showOpen({ title: tr('Importuj z pliku'), properties: ['openFile', 'showHiddenFiles'], ...(existsSync(sshDir) ? { defaultPath: sshDir } : {}) });
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
    saveKeyFile: async (name) => {
      const options = { title: tr('Zapisz klucz prywatny do pliku...'), defaultPath: name };
      const r = isLive(win) ? await dialog.showSaveDialog(win!, options) : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    readKeyFile: readKeyFileFromDisk,
    writeKeyFile: async (path, text) => writePrivateFile(path, text),
    hostname: () => hostname(),
  }), fromAppWindow);
}

// ── pty host ────────────────────────────────────────────────────────────────

ptyHost.on('message', (m: HostToMain) => {
  if ('id' in m && m.id.startsWith(INSTALL_PTY_PREFIX)) { install.onHostMessage(m); return; } // the install window is not a cell
  if ('id' in m && m.id.startsWith('auth:')) return; // login windows are not cells
  if (ssh?.onHostMessage(m)) return;
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
  install.failActive();
  for (const id of alive) { mcp.revokeCell(id); automation.statuses.set(id, 'exited'); }
  verifiedCodex.clear();
  ssh?.hostCrashed();
  const resumes = resumesConversation([...alive].map((id) => {
    const found = findCell(state, id);
    return found ? { ssh: !!found.cell.ssh, cli: getProfile(state, found.cell.profileId).cli } : undefined;
  }));
  alive.clear();
  send('ptyhost:crashed', resumes);
});
ptyHost.on('fatal', () => {
  alive.clear();
  dialog.showErrorBox('unimux', tr('Proces terminali wielokrotnie się wysypał. Uruchom aplikację ponownie.'));
});

hooks.on('hook', (cellId: string, event: string, info?: unknown) => {
  if (!findCell(state, cellId)) return; // stale or foreign id
  // Immediate hints only for events the tracker always applies; busy is left to the tracker (it may ignore late tool hooks)
  // and reaches automation through cell:runtime.
  const hint = automationHintForHook(event);
  if (hint) automation.statuses.set(cellId, hint);
  send('cell:hook', cellId, event, info);
});

// SessionStart ends the "background tasks still running" mode of the cell (they belong to a previous conversation).
hooks.on('sessionstart', (cellId: string, source?: string) => {
  if (!findCell(state, cellId)) return;
  send('cell:hook', cellId, 'session', { source });
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

/** Cells whose notify hook reported in this process: their session is bound by the renderer's committed turn ends and the file-timestamp guess never touches it. */
const codexHooked = new Set<string>();

// A Codex turn completed (its `notify` program posted the payload). The renderer's StatusTracker decides whether it was the
// cell's own turn end (quiet follows) or a sub-agent / mid-turn one (output goes on), and binds the thread accordingly.
hooks.on('codex', (cellId: string, notice: CodexNotice) => {
  const found = findCell(state, cellId);
  if (!found || !alive.has(cellId) || getProfile(state, found.cell.profileId).cli !== 'codex') return; // stale or foreign
  codexHooked.add(cellId);
  send('cell:hook', cellId, 'stop', { codex: true, ...(notice.turnId ? { turnId: notice.turnId } : {}), ...(notice.threadId ? { threadId: notice.threadId } : {}) });
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
  if (codexHooked.has(cellId)) return null; // its notify hook binds the exact thread; a timestamp guess must never overwrite it
  const id = findRecentCodexSession(homedir(), cwd, 20_000, boundCodexIds());
  if (!id) return null;
  claimedCodex.add(id);
  send('cell:session', cellId, { cli: 'codex', id, confirmed: false });
  return id;
});

// ── ipc ─────────────────────────────────────────────────────────────────────

ipcMain.handle('state:load', () => state);
ipcMain.handle('state:snapshot', () => controller.snapshot());
// The answer is an acknowledgement; the new state reaches the renderer once, as the patch `state:changed` carries.
ipcMain.handle('state:edit', (_e, edit: StateEdit) => { const { revision, editId } = controller.apply(edit); return { revision, editId }; });
ipcMain.handle('mcp:info', (): McpInfo => ({ ...mcp.getInfo(), error: mcpError }));
ipcMain.handle('automation:execute', (_e, operation: AutomationOperation, input: unknown) => {
  if (!Object.hasOwn(automationSchemas, operation)) throw new Error('Unknown operation.');
  return automation.execute(operation, input);
});

ipcMain.handle('cell:spawn', (_e, req: SpawnCellRequest) => spawnRequest(req));
type SpawnResult = { ok: true } | { ok: false; error: string; cliMissing?: CliId; cliStatus?: CliStatus };
async function spawnRequest(req: SpawnCellRequest): Promise<SpawnResult> {
  if (!existsSync(req.cwd)) return { ok: false, error: tr('Folder nie istnieje: {path}', { path: req.cwd }) };
  const killsBefore = killCount.get(req.cellId) ?? 0;
  const cli = cliForProfile(req.profile);
  // `force`: the user chose "start anyway" on the install card (the detection may be wrong, e.g. an alias).
  if (cli && req.force !== true) {
    // A definite "not installed" never spawns a shell that would only print "command not found"; unknown fails open.
    const status = await cliDetector.get(cli, { waitMs: CLI_WAIT_MS }).catch(() => undefined);
    if (!spawnDecision(req.profile, status).spawn) {
      mcp.revokeCell(req.cellId);
      alive.delete(req.cellId);
      automation.statuses.set(req.cellId, 'exited');
      return { ok: false, error: tr('{name} nie jest zainstalowany', { name: CLI_NAMES[cli] }), cliMissing: cli, cliStatus: status };
    }
  }
  const baseEnv = await cliDetector.applyEnv({ ...cleanEnv(process.env), MC_CELL_ID: req.cellId }, cli ?? undefined);
  if ((killCount.get(req.cellId) ?? 0) !== killsBefore) return { ok: true }; // the cell was closed while the CLI was being looked up
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
  const env: Record<string, string> = baseEnv;
  let mcpConfig: { url: string; tokenEnv: string; claudeConfigPath: string } | undefined;
  if (req.profile.cli !== 'shell' && findCell(state, req.cellId)?.cell.role && mcp.getInfo().running) {
    env.UNIMUX_MCP_TOKEN = mcp.issueToken(req.cellId);
    const url = mcp.getInfo().url!;
    mkdirSync(MCP_DIR, { recursive: true });
    const claudeConfigPath = join(MCP_DIR, `${req.cellId}.json`);
    writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: { unimux: {
      type: 'http', url, headers: { Authorization: 'Bearer ${UNIMUX_MCP_TOKEN}' },
    } } }), 'utf8');
    mcpConfig = { url, tokenEnv: 'UNIMUX_MCP_TOKEN', claudeConfigPath };
  } else mcp.revokeCell(req.cellId);
  // Codex reports every finished turn (and its conversation id) to the local hook server through a per-process `notify`.
  let codexNotifyUrl: string | undefined;
  if (req.profile.cli === 'codex') {
    codexNotifyUrl = hooks.prepareCodex(req.cellId);
    codexHooked.delete(req.cellId);
  }
  const command = buildLaunchCommand(req.profile, { mode, sessionId: req.sessionId, claudeSettingsPath, codexNotifyUrl,
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
  noteKill(id);
  ssh?.killed(id);
  mcp.revokeCell(id);
  verifiedCodex.delete(id);
  automation.statuses.set(id, 'exited');
  alive.delete(id);
  ptyHost.kill(id);
});
ipcMain.handle('cell:killAndWait', async (_e, id: string) => {
  noteKill(id);
  ssh?.killed(id);
  mcp.revokeCell(id);
  verifiedCodex.delete(id);
  automation.statuses.set(id, 'exited');
  alive.delete(id);
  await ptyHost.killAndWait(id);
});
ipcMain.handle('cell:alive', () => [...alive]);
const cliHandlers = createCliHandlers(cliDetector, (url) => { void shell.openExternal(url); });
ipcMain.handle('cli:status', () => cliHandlers.status());
ipcMain.handle('cli:recheck', (_e, id?: unknown) => cliHandlers.recheck(id));
ipcMain.on('cli:openDocs', (_e, id?: unknown) => { cliHandlers.openDocs(id); });
const installHandlers = createInstallHandlers(install);
ipcMain.handle('install:options', (_e, cli?: unknown) => installHandlers.options(cli));
ipcMain.handle('install:start', (_e, request?: unknown) => installHandlers.start(request));
ipcMain.on('install:cancel', (_e, id?: unknown) => { installHandlers.cancel(id); });
ipcMain.handle('install:current', () => installHandlers.current());
ipcMain.on('cell:runtime', (_e, cellId: string, status: string, reason?: string, hooked?: boolean) => {
  const found = findCell(state, cellId);
  if (!found || !alive.has(cellId)) return;
  // The renderer's StatusTracker decides; heuristics (hooked = false) never yield "ready".
  const next = automationStatusFor(status, reason, hooked === true, automation.statuses.get(cellId));
  if (next) automation.statuses.set(cellId, next);
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
// The path is never taken from the renderer: only the saved setting of that event (set from the dialog result) is read.
ipcMain.handle('sound:load', (_e, event?: unknown, knownKey?: unknown) => loadEventSound(state.settings.alerts, event, knownKey));
ipcMain.on('sound:beep', () => shell.beep());
ipcMain.handle('fs:exists',(_e, p: string) => existsSync(p));
/** Files dropped from the system file manager: whether each absolute path is a folder, a file or gone. */
ipcMain.handle('fs:pathKinds', async (_e, paths: unknown): Promise<Array<'dir' | 'file' | null>> => {
  if (!Array.isArray(paths) || paths.length > 200) return [];
  return Promise.all(paths.map(async (p) => {
    if (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0')) return null;
    try { const info = await stat(p); return info.isDirectory() ? 'dir' as const : info.isFile() ? 'file' as const : null; } catch { return null; }
  }));
});
ipcMain.handle('fs:listProjectDirectory', (_e, projectId: string, path: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? listProjectDirectory(project.path, path) : { ok: false, error: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:listProjectDirectoryBatch', (_e, projectId: string, paths: unknown) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? listProjectDirectoryBatch(project.path, paths) : {};
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
ipcMain.handle('fs:readProjectFile', (_e, projectId: string, path: string, large?: boolean) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? readProjectFile(project.path, path, large === true ? LARGE_VIEW_BYTES : undefined) : { kind: 'error', message: 'Projekt już nie istnieje.' };
});
ipcMain.handle('fs:writeProjectFile', (_e, projectId: string, path: string, text: string, expectedText: string) => {
  const project = state.projects.find((p) => p.id === projectId);
  return project ? writeProjectFile(project.path, path, text, expectedText) : { ok: false, error: 'Projekt już nie istnieje.' };
});
registerFileOpsIpc({ projectPath: (projectId) => state.projects.find((p) => p.id === projectId)?.path, send });
ipcMain.handle('sessions:list', (_e, projectPath: string) => listSessionsAsync(homedir(), projectPath));
registerGitIpc({
  projectPath: (projectId) => state.projects.find((p) => p.id === projectId)?.path,
  worktreePaths: (projectId) => state.projects.find((p) => p.id === projectId)?.tabs.flatMap((t) => t.cells.flatMap((c) => (c.worktree ? [c.worktree.path] : []))) ?? [],
  trustFile: join(DATA_DIR, 'git-trust.json'),
});
ipcMain.handle('git:isRepo', (_e, p: string) => isGitRepo(p));
ipcMain.handle('git:createWorktree', (_e, p: string, name: string) => createWorktree(p, name));
ipcMain.handle('git:removeWorktree', (_e, p: string, wt: Worktree, del: boolean) => removeWorktree(p, wt, del));

ipcMain.on('notify', (_e, n: { title: string; body: string; cellId: string }) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification(notificationOptions(n));
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
    if (n.cellId) send('focus-cell', n.cellId);
  });
  notification.show();
});
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text));
/** A copied private key (0.9.3): the clearing waits here, not in the window, so a reload or quit within the minute still clears it. */
const secretClipboard = createSecretClipboard({
  read: () => clipboard.readText(),
  write: (text) => clipboard.writeText(text),
  digest: (text) => createHash('sha256').update(text).digest('hex'),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
/** Clears a still waiting copied key now; resolves within `ms` whatever the clipboard does. */
const flushSecretClipboard = (ms = 400): Promise<void> =>
  Promise.race([secretClipboard.flush().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, ms))]);
ipcMain.handle('clipboard:writeSecret', async (e, text: unknown) => {
  if (!fromAppWindow(e) || typeof text !== 'string' || !text) return false;
  await secretClipboard.copy(text);
  return true;
});
// A quit that skips the wind-down below (an update taking over) still clears a waiting key before the process ends.
app.on('will-quit', (e) => {
  if (!secretClipboard.pending()) return;
  e.preventDefault();
  void flushSecretClipboard().then(() => app.exit(0));
});
ipcMain.on('shell:openExternal', (_e, address: string) => {
  try { const url = new URL(address); if (['http:', 'https:'].includes(url.protocol)) void shell.openExternal(url.href); } catch { /* invalid address */ }
});
ipcMain.on('shell:openPath', (_e, p: string) => shell.openPath(p));
ipcMain.on('shell:revealPath', (_e, p: string) => shell.showItemInFolder(p));
const changelog = createChangelog({
  cacheFile: join(DATA_DIR, 'changelog.json'),
  fetchJson: async (url) => {
    const response = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'unimux' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`GitHub ${response.status}`);
    return response.json();
  },
});
ipcMain.handle('changelog:get', (_e, force: boolean) => changelog.get(force));
// Accounts, login and usage (0.9.3): everything that changes something only answers the app window (accountsIpc.ts).
registerAccountIpc(ipcMain, {
  getUsage: () => usage.getState(),
  refreshUsage: () => usage.refresh(true),
  startLogin: (request) => {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return { ok: false, error: 'invalid request' };
    return loginBlock(guardDeps, request).then((block) => (block ? { ok: false as const, error: block } : login.start(request as LoginRequest)));
  },
  cancelLogin: (id) => { if (typeof id === 'string') login.cancel(id); },
  removeAccount: (id) => handleRemoveAccount({
    ...guardDeps,
    isLive: (accountId) => accounts.live()?.recordId === accountId || custodyOf(accounts.get(accountId) ?? {}) === 'live',
    cancelLogin: (accountId) => login.cancelFor(accountId),
    remove: (accountId) => accounts.remove(accountId),
    onRemoved: () => { void usage.refresh(true, true); },
  }, id),
  makeMain: async (id) => {
    const result = await handleMakeMain({
      loginActive: () => login.isActive(),
      validate: (accountId) => checkActivationTarget(activateDeps(), accountId),
      swap: (accountId) => activateAccount(activateDeps(), accountId),
      onSwapped: () => { if (typeof id === 'string') void usage.refresh(true, true, `claude:${id}`); },
    }, id);
    void pushSwapPending();
    return result;
  },
  /** "Renew this copy in unimux": the user confirmed that a saved copy cswap also lists is the app's own login. */
  adoptCopy: (id) => handleAdoptCopy({
    ...guardDeps,
    loginActive: () => login.isActive(),
    get: (accountId) => accounts.get(accountId),
    live: () => accounts.live(),
    setFamily: (accountId, family) => accounts.setFamily(accountId, family),
    onAdopted: (accountId) => { void usage.refresh(true, true, `claude:${accountId}`); },
  }, true, id), // the sender was checked by registerAccountIpc
  swapPending: () => hasPendingSwap(swapDeps()).catch(() => true),
  /** The user confirmed that the emergency copy of an unresolved swap may be deleted for good. */
  clearSwapPending: async () => {
    // A recovery still waiting for Claude Code's locks can repair the state itself: its backups are not deleted meanwhile
    // (the panel says so and that the app retries).
    if (isActivationRecoveryPending()) return { ok: false, error: 'locked' as const };
    const cleared = await clearPendingActivation(activateDeps(), () => clearPendingSwap(swapDeps()));
    void pushSwapPending();
    return { ok: cleared };
  },
  dismissNotice: (id) => {
    try {
      dismissAccountNotice(accounts, id);
    } finally {
      send('usage:state', usage.getState());
    }
  },
}, fromAppWindow);
usage.onChange((snapshot) => send('usage:state', snapshot));
ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('update:get', () => ({ ...getUpdateState(), currentVersion: app.getVersion() }));
ipcMain.on('update:install', () => openInstallWindow());
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

const MAC_GATE_DOWNLOAD_TOTAL_MS = 10 * 60 * 1000;
const writeGateRecord = (version: string) => { try { writeFileSync(GATE_FILE, JSON.stringify({ version, at: Date.now() })); } catch { /* best effort */ } };
const recordUpdateFailure = (version: string) => { writeGateRecord(version); blockUpdateVersion(version); };

/** The record of an attempt or failure ends once the version it targeted (or a newer one) is actually running. */
function clearGateFailureIfUpdated(): void {
  const record = readGateFailure();
  if (record && compareVersions(app.getVersion(), record.version) >= 0) { try { rmSync(GATE_FILE, { force: true }); } catch { /* retried on next start */ } }
}

/** The texts of the in-app update window (startup prompt and the window opened from the status bar). */
const gateTexts = (failed: string): GateTexts => ({
  checking: tr('Sprawdzanie aktualizacji…'),
  downloading: tr('Pobieranie aktualizacji…'),
  updating: (next) => tr('Aktualizacja do wersji {version}', { version: next }),
  hint: tr('Nie wyłączaj komputera. unimux uruchomi się automatycznie.'),
  preparing: tr('Przygotowanie aktualizacji…'),
  failed,
  close: tr('Zamknij'),
  available: (next) => tr('Dostępna nowa wersja {version}', { version: next }),
  askMessage: tr('Zainstalować ją teraz?'),
  askHint: tr('„Później” uruchamia obecną wersję. Zainstalujesz ją przyciskiem w stopce.'),
  install: tr('Zainstaluj teraz'),
  later: tr('Później'),
});

/** At most one update window or prompt at a time: the startup prompt, the window of the status bar button and the hand-over. */
const updateUi = createUpdateUiGuard();

/** Runs the updater before the main window exists; resolves true when the installer took over and the app must not start. */
async function runUpdateGate(): Promise<boolean> {
  let window: ReturnType<typeof createGateWindow> | undefined;
  try {
    const failure = readGateFailure();
    const recent = isActiveFailure(failure, app.getVersion(), Date.now());
    if (failure && recent && state.settings.updateMode !== 'manual') blockUpdateVersion(failure.version);
    if (!shouldGateOnStartup({
      platform: process.platform, packaged: updatesEnabled(), portable: isPortableBuild(),
      mode: state.settings.updateMode, recentFailure: recent,
    })) return false;
    const version = app.getVersion();
    if (!updateUi.acquire('startup-gate')) return false;
    window = createGateWindow(gateTexts(tr('Aktualizacja nie powiodła się - uruchamiam obecną wersję')), version);
    gating = true;
    let handedOver = '';
    const result = await runStartupGate({
      check: startupCheck, recheck: recheckUpdate, download: startupDownload, target: updateTarget, onTargetChange: onUpdateTargetChange, isDownloaded: isUpdateDownloaded,
      handoff: (next, hide, signal) => { handedOver = next; return handOver(next, hide, signal); }, handoffCommitted: updateHandoverCommitted,
      show: window.show, hide: window.hide, onCancel: window.onCancel, onInstall: window.onInstall,
      // Only while the failure is recent (after the cooldown the version is offered again).
      skipVersion: gateSkipVersion(failure, app.getVersion(), Date.now()),
      // The macOS archive is about 140 MB: allow more than the default for the whole download.
      downloadTotalMs: process.platform === 'darwin' ? MAC_GATE_DOWNLOAD_TOTAL_MS : undefined,
      markAttempt: writeGateRecord, recordFailure: recordUpdateFailure,
    });
    if (result !== 'installing') { gating = false; updateUi.release('startup-gate'); return false; }
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
      updateUi.release('startup-gate');
      void startMainApp().catch((error) => console.error('startup failed', error));
    };
    handoffWatchdog = setTimeout(watch, HANDOFF_QUIT_WATCHDOG_MS);
    return true;
  } catch (error) {
    console.error('startup update gate failed', error);
    try { window?.hide(); } catch { /* already gone */ }
    gating = false;
    updateUi.release('startup-gate');
    return false;
  }
}

/**
 * The status bar button of an offered, downloading or downloaded update: opens the one update window, which shows the
 * download (joining the running one), then the hand-over to the installer. A window that is already open (also the
 * startup prompt) is the only one there ever is.
 */
function openInstallWindow(): void {
  const version = updateTarget();
  if (!version || !canInstallNow() || !updateUi.acquire('install-window')) return;
  void (async () => {
    let handed = false;
    try {
      const window = createGateWindow(gateTexts(tr('Aktualizacja nie powiodła się')), app.getVersion());
      // macOS has no separate installing window: the in-app one stays visible while the app winds down.
      const keepOpen = process.platform === 'darwin';
      const result = await runInstallWindow({
        check: startupCheck, recheck: recheckUpdate, download: startupDownload, target: updateTarget, onTargetChange: onUpdateTargetChange, isDownloaded: isUpdateDownloaded,
        handoff: (next, hide, signal) => handOver(next, keepOpen ? () => {} : hide, signal), handoffCommitted: updateHandoverCommitted,
        markAttempt: writeGateRecord,
        show: window.show, hide: window.hide, onCancel: window.onCancel, onInstall: window.onInstall,
        // The failure is shown by the status bar (with a retry); nothing is remembered for the next start.
        recordFailure: () => {},
        downloadTotalMs: process.platform === 'darwin' ? MAC_GATE_DOWNLOAD_TOTAL_MS : undefined,
      }, version);
      handed = result === 'installing';
    } catch (error) {
      // A window that cannot be created must not make the button dead: an update that is already downloaded installs without it.
      console.error('update window failed', error);
      if (!handed && isUpdateDownloaded(version)) handed = await handOver(version, () => {}).catch(() => false);
    }
    finally { if (!handed) updateUi.release('install-window'); }
  })();
}

async function startMainApp(): Promise<void> {
  await hooks.start();
  try { await mcp.start(); } catch (error) { mcpError = error instanceof Error ? error.message : String(error); }
  ptyHost.start();
  startSsh();
  // An interrupted main-account swap is repaired (or reported as pending) before any window or IPC call can start another:
  // first a 0.9.1 (version 2) journal, otherwise the 0.9.0 recovery decides.
  try {
    // Shorter lock waits here: the window waits for this; a recovery still 'locked' is retried by the polls.
    if ((await recoverActivationWithRetry({ ...activateDeps(), locks: { timeoutMs: 3_000 } })) === 'legacy') await recoverInterruptedSwap(swapDeps());
  } catch { /* the journal stays and the next start retries */ }
  // A recovery still 'locked' is retried by its own timer too: the polls do not run while the limits panel is off.
  startActivationRecoveryRetry(retryActivationRecovery);
  // 0.9.0 -> 0.9.1: identities and duplicates of the saved accounts (once; nothing is deleted).
  try { await migrateAccounts(migrationDeps()); } catch { /* retried at the next start */ }
  createWindow();
  void cliDetector.refreshAll(); // async: the window does not wait for it, spawns wait only for their own CLI
  usage.start();
  scheduleUpdateCleanup();
}

app.whenReady().then(async () => {
  applyDockIcon();
  if (superseded) return;
  // No default menu: its Ctrl+W / Ctrl+R accelerators would close or reload the window.
  Menu.setApplicationMenu(null);
  initUpdater((s) => send('update:state', s), { strings: updateStrings });
  // macOS: an update whose swap did not happen counts as a failure of that version (the cooldown applies).
  const previous = await previousMacUpdate();
  if (previous.kind === 'failed') recordUpdateFailure(previous.version);
  // The new version is up: the update window of the update that just finished may say "done" now, and nothing of this start may
  // appear next to it (the prompt of a still newer release comes after it has gone).
  if (process.platform === 'win32' && app.isPackaged) { await signalUpdateReady(); await waitForUpdateWindowGone(4000); }
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
  void dialog.showMessageBox({ type: 'error', title: 'unimux', message: tr('Wystąpił nieoczekiwany błąd w głównym procesie'), detail }).catch(() => {});
});

/** Ends the process; a launch that was swallowed during the wind-down is repeated, unless an update took over. */
function exitNow(): void {
  if (shouldRelaunchAfterQuit(relaunchRequested, updateHandoffStarted())) { try { app.relaunch(); } catch { /* nothing else to do */ } }
  // A key copied during the wind-down is cleared too (before-quit already cleared the earlier one).
  if (secretClipboard.pending()) void flushSecretClipboard().then(() => app.exit(0));
  else app.exit(0);
}

app.on('before-quit', (e) => {
  clearTimeout(handoffWatchdog);
  // A copied private key does not outlive the app in the clipboard, however the quit goes on (the wind-down below waits).
  void flushSecretClipboard();
  // The installer took over before anything was started, so there is nothing to wind down.
  if (quitting || gating || superseded) return;
  e.preventDefault();
  quitting = true;
  // However the wind-down goes (stuck terminals), the process must end: a running installer waits for it.
  const shutdownLimit = setTimeout(() => { crashLog.warn('shutdown overran its limit, exiting'); ptyHost.forceKill(); exitNow(); }, SHUTDOWN_HARD_LIMIT_MS);
  usage.stop();
  login.dispose();
  install.dispose();
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
