/**
 * Self-update for the macOS build, which is ad-hoc signed: Squirrel.Mac (electron-updater) rejects such updates, so the new
 * app is fetched from the GitHub release, verified and swapped in by a small shell script after the app has quit.
 *
 * Free of Electron imports. Network, process and file system access are injected so the whole flow runs in unit tests
 * on any platform. Every macOS-specific command runs only through `exec` / `spawnDetached`.
 */
import { createHash } from 'crypto';
import { constants } from 'fs';
import type * as FsPromises from 'fs/promises';
import { posix } from 'path';
import { compareVersions } from '../startupGate';
import { MAC_FEED_URL, macAssetBase, parseLatestMacYml, selectMacAsset, type MacAsset } from './feed';
import { buildInstallScript, SCRIPT_READY_SECONDS, SCRIPT_WAIT_SECONDS } from './script';
import { backupPathFor, bundlePathFromExecPath, evaluateInstallTarget, probeBundleWrite, type MacRefusal, type TargetFs } from './target';

export { MAC_FEED_URL, macAssetBase };
export type { MacRefusal };

export const MAC_MESSAGES = {
  noAsset: 'Nie znaleziono aktualizacji dla tego typu procesora Maca.',
  server: 'Serwer aktualizacji zwrócił błąd. Spróbuj ponownie później.',
  stalled: 'Pobieranie aktualizacji zostało przerwane - serwer przestał wysyłać dane.',
  damaged: 'Pobrana aktualizacja jest uszkodzona (zła suma kontrolna lub rozmiar).',
  extract: 'Nie udało się rozpakować aktualizacji.',
  verify: 'Pobrana aktualizacja nie przeszła weryfikacji i nie zostanie zainstalowana.',
  spawn: 'Nie udało się uruchomić instalatora aktualizacji.',
  quitTimeout: 'Aplikacja nie zamknęła się na czas - aktualizacja została przerwana.',
} as const;

/** Polish message keys describing why the app is not replaced in place (translated in the renderer). */
export const REFUSAL_MESSAGES: Record<MacRefusal, string> = {
  'not-bundle': 'Automatyczna instalacja jest niedostępna: aplikacja nie działa z pakietu .app. Pobierz nową wersję ręcznie.',
  translocated: 'Automatyczna instalacja jest niedostępna: macOS uruchomił aplikację z tymczasowej lokalizacji. Przenieś ajzakomator do folderu Programy, uruchom go stamtąd lub pobierz nową wersję ręcznie.',
  'read-only': 'Automatyczna instalacja jest niedostępna: aplikacja działa z dysku tylko do odczytu (np. z obrazu DMG). Przenieś ją do folderu Programy lub pobierz nową wersję ręcznie.',
  'not-writable': 'Automatyczna instalacja jest niedostępna: brak zapisu w folderze z aplikacją. Pobierz nową wersję ręcznie.',
  'not-owner': 'Automatyczna instalacja jest niedostępna: aplikacja należy do innego użytkownika. Pobierz nową wersję ręcznie.',
  'app-management': 'macOS nie pozwolił zmienić aplikacji. Zezwól ajzakomatorowi w Ustawieniach systemowych (Prywatność i ochrona, Zarządzanie aplikacjami) albo pobierz nową wersję ręcznie.',
};

/** The download may be silent for this long before it counts as failed (same as the Windows start-up gate). */
export const MAC_DOWNLOAD_STALL_MS = 60 * 1000;
/** Upper bound for one download of the ~140 MB archive, however steadily it progresses. */
export const MAC_DOWNLOAD_TOTAL_MS = 15 * 60 * 1000;
const FEED_TIMEOUT_MS = 15 * 1000;
const EXEC_TIMEOUT_MS = 5 * 60 * 1000;
/** A marker younger than this may still belong to a running update script. */
export const PENDING_GRACE_MS = 2 * 60 * 1000;
const LOG_LIMIT_BYTES = 100 * 1024;

export type MacFs = Pick<typeof FsPromises, 'mkdir' | 'readdir' | 'rm' | 'stat' | 'writeFile' | 'readFile' | 'open' | 'access' | 'appendFile' | 'rename'>;

export interface ExecResult { code: number | null; stdout: string; stderr: string; /** The command does not exist on this system. */ missing?: boolean }

export interface MacUpdaterDeps {
  arch: string;
  currentVersion: string;
  /** `process.execPath` of the running app. */
  execPath: string;
  pid: number;
  packaged: boolean;
  /** Staging directory (`<userData>/updates/mac`), always a POSIX path. */
  updateDir: string;
  feedUrl: string;
  assetBase(version: string): string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  fs: MacFs;
  exec(command: string, args: string[], timeoutMs: number): Promise<ExecResult>;
  /** Starts a process that outlives the app; false when it could not start. */
  spawnDetached(command: string, args: string[]): Promise<boolean>;
  uid?(): number | undefined;
  now(): number;
  /** Extra sink (console); the update log file is always written. */
  log?(line: string): void;
  stallMs?: number;
  totalMs?: number;
  scriptWaitSeconds?: number;
  scriptReadySeconds?: number;
}

export interface MacOffer {
  version: string;
  asset: MacAsset;
  url: string;
  /** Set when the app cannot replace itself; the offer then only links to the download page. */
  refusal?: MacRefusal;
}

export interface MacCheckResult { latest: string; offer?: MacOffer }
export interface MacStaged { version: string; bundle: string; executable: string; zip: string; extractDir: string }
export interface MacProgress { percent: number; transferred: number; total: number; bytesPerSecond: number }
export type MacInstallResult = { ok: true } | { ok: false; refusal: MacRefusal };
export type MacPreviousOutcome = { kind: 'none' } | { kind: 'updated'; version: string } | { kind: 'failed'; version: string };

interface PendingMarker { from: string; to: string; at: number; bundle: string; backup: string }

/** Value of a top-level string key of an XML property list; undefined when the key is missing. */
export function plistString(xml: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  if (!match) return undefined;
  return match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const fail = (message: string): Error => new Error(message);

export class MacUpdater {
  private readonly dir: string;
  constructor(private readonly d: MacUpdaterDeps) { this.dir = d.updateDir; }

  private get logFile(): string { return posix.join(this.dir, 'update.log'); }
  private get markerFile(): string { return posix.join(this.dir, 'pending.json'); }
  private get readyFile(): string { return posix.join(this.dir, 'ready'); }

  /** Appends to `update.log` (public information only: versions, file names and paths) and to the optional sink. */
  async note(line: string): Promise<void> {
    try { this.d.log?.(line); } catch { /* a sink must not break updating */ }
    try {
      await this.d.fs.mkdir(this.dir, { recursive: true });
      const size = await this.d.fs.stat(this.logFile).then((s) => s.size, () => 0);
      if (size > LOG_LIMIT_BYTES) await this.d.fs.writeFile(this.logFile, '');
      await this.d.fs.appendFile(this.logFile, `${new Date(this.d.now()).toISOString()} ${line}\n`);
    } catch { /* logging must never break updating */ }
  }

  private targetFs(): TargetFs {
    const fs = this.d.fs;
    return {
      accessWritable: (path) => fs.access(path, constants.W_OK),
      ownerOf: (path) => fs.stat(path).then((s) => s.uid, () => undefined),
      uid: () => this.d.uid?.(),
    };
  }

  private async request(url: string, signal: AbortSignal): Promise<Response> {
    const response = await this.d.fetch(url, { headers: { 'User-Agent': 'ajzakomator-updater', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }, signal, redirect: 'follow' });
    if (!response.ok) {
      await this.note(`request failed: HTTP ${response.status} for ${url}`);
      throw fail(MAC_MESSAGES.server);
    }
    return response;
  }

  /** Reads the feed. Without an offer the running version is current (`latest` is what the feed announces). */
  async check(): Promise<MacCheckResult> {
    const text = await (await this.request(this.d.feedUrl, AbortSignal.timeout(FEED_TIMEOUT_MS))).text();
    const feed = parseLatestMacYml(text);
    if (compareVersions(feed.version, this.d.currentVersion) <= 0) return { latest: feed.version };
    const asset = selectMacAsset(feed, this.d.arch);
    if (!asset) {
      await this.note(`the feed lists no archive for ${this.d.arch} (version ${feed.version})`);
      throw fail(MAC_MESSAGES.noAsset);
    }
    const target = await evaluateInstallTarget(this.d.execPath, this.d.packaged, this.targetFs());
    const offer: MacOffer = { version: feed.version, asset, url: new URL(asset.name, this.d.assetBase(feed.version)).href };
    if (!target.ok) {
      offer.refusal = target.reason;
      await this.note(`update ${feed.version} found, but this app is not replaced in place: ${target.reason}`);
    }
    return { latest: feed.version, offer };
  }

  /** Removes everything in the staging directory except the log, the readiness flag, the marker and `keep`. */
  async cleanStaging(keep: string[] = []): Promise<void> {
    const preserved = new Set(['update.log', 'ready', 'pending.json', ...keep]);
    const names = await this.d.fs.readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(names.filter((name) => !preserved.has(name)).map((name) => this.d.fs.rm(posix.join(this.dir, name), { recursive: true, force: true }).catch(() => {})));
  }

  /** Downloads, verifies, unpacks and checks the update; resolves once the new bundle is ready to be swapped in. */
  async download(offer: MacOffer, onProgress: (progress: MacProgress) => void): Promise<MacStaged> {
    const { fs } = this.d;
    await fs.mkdir(this.dir, { recursive: true });
    const zip = posix.join(this.dir, offer.asset.name);
    await this.cleanStaging([offer.asset.name]);
    if (await this.zipIsGood(zip, offer.asset)) {
      await this.note(`reusing the verified archive ${offer.asset.name}`);
      onProgress({ percent: 100, transferred: offer.asset.size, total: offer.asset.size, bytesPerSecond: 0 });
    } else {
      await fs.rm(zip, { force: true });
      await this.fetchArchive(offer, zip, onProgress);
    }
    const extractDir = posix.join(this.dir, `extracted-${offer.version}`);
    await fs.rm(extractDir, { recursive: true, force: true });
    await fs.mkdir(extractDir, { recursive: true });
    const unpacked = await this.d.exec('/usr/bin/ditto', ['-x', '-k', zip, extractDir], EXEC_TIMEOUT_MS);
    if (unpacked.code !== 0) {
      await this.note(`ditto failed (${unpacked.code}): ${unpacked.stderr.trim().slice(0, 300)}`);
      throw fail(MAC_MESSAGES.extract);
    }
    const apps = (await fs.readdir(extractDir)).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) { await this.note(`the archive holds ${apps.length} app bundles, expected 1`); throw fail(MAC_MESSAGES.verify); }
    const bundle = posix.join(extractDir, apps[0]);
    // Files written by this process carry no quarantine flag; this only guards against one that was set anyway.
    await this.d.exec('/usr/bin/xattr', ['-cr', bundle], EXEC_TIMEOUT_MS).catch(() => undefined);
    const executable = await this.verifyBundle(bundle, offer.version);
    await this.note(`update ${offer.version} downloaded, unpacked and verified`);
    return { version: offer.version, bundle, executable, zip, extractDir };
  }

  private async hashFile(path: string): Promise<string> {
    const handle = await this.d.fs.open(path, 'r');
    try {
      const hash = createHash('sha512');
      for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
      return hash.digest('base64');
    } finally { await handle.close().catch(() => {}); }
  }

  private async zipIsGood(zip: string, asset: MacAsset): Promise<boolean> {
    try {
      if ((await this.d.fs.stat(zip)).size !== asset.size) return false;
      return await this.hashFile(zip) === asset.sha512;
    } catch { return false; }
  }

  private async fetchArchive(offer: MacOffer, zip: string, onProgress: (progress: MacProgress) => void): Promise<void> {
    const { fs, now } = this.d;
    const part = `${zip}.part`;
    const controller = new AbortController();
    let interrupted = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const interrupt = () => { interrupted = true; controller.abort(); };
    const arm = () => { clearTimeout(stallTimer); stallTimer = setTimeout(interrupt, this.d.stallMs ?? MAC_DOWNLOAD_STALL_MS); };
    const totalTimer = setTimeout(interrupt, this.d.totalMs ?? MAC_DOWNLOAD_TOTAL_MS);
    let handle: Awaited<ReturnType<MacFs['open']>> | undefined;
    let finished = false;
    try {
      arm();
      const response = await this.request(offer.url, controller.signal);
      if (!response.body) throw fail(MAC_MESSAGES.server);
      arm();
      handle = await fs.open(part, 'w');
      const hash = createHash('sha512');
      const reader = response.body.getReader();
      const started = now();
      let transferred = 0;
      let reported = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        transferred += value.length;
        if (transferred > offer.asset.size) { await this.note(`the download is larger than announced (${offer.asset.size} bytes)`); throw fail(MAC_MESSAGES.damaged); }
        hash.update(value);
        await handle.write(value);
        const time = now();
        if (time - reported >= 250) {
          reported = time;
          const seconds = Math.max(0.001, (time - started) / 1000);
          onProgress({ percent: (transferred / offer.asset.size) * 100, transferred, total: offer.asset.size, bytesPerSecond: transferred / seconds });
        }
      }
      await handle.close();
      handle = undefined;
      if (transferred !== offer.asset.size || hash.digest('base64') !== offer.asset.sha512) {
        await this.note(`the downloaded archive does not match the feed (${transferred} of ${offer.asset.size} bytes, or a different sha512)`);
        throw fail(MAC_MESSAGES.damaged);
      }
      onProgress({ percent: 100, transferred, total: offer.asset.size, bytesPerSecond: 0 });
      await fs.rename(part, zip);
      finished = true;
    } catch (error) {
      if (interrupted) { await this.note('the download stalled or took too long'); throw fail(MAC_MESSAGES.stalled); }
      throw error;
    } finally {
      clearTimeout(stallTimer); clearTimeout(totalTimer);
      await handle?.close().catch(() => {});
      if (!finished) await fs.rm(part, { force: true }).catch(() => {});
    }
  }

  private async readPlist(path: string): Promise<string> {
    const text = await this.d.fs.readFile(path, 'utf8');
    if (text.includes('<plist')) return text;
    // A binary property list: let macOS convert it.
    const converted = await this.d.exec('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', path], EXEC_TIMEOUT_MS);
    if (converted.code !== 0) throw new Error('unreadable Info.plist');
    return converted.stdout;
  }

  /** Version, identifier, executable and code signature of the unpacked bundle; returns the executable name. */
  private async verifyBundle(bundle: string, version: string): Promise<string> {
    const reject = async (why: string): Promise<never> => { await this.note(`verification failed: ${why}`); throw fail(MAC_MESSAGES.verify); };
    let info: string;
    let running: string | undefined;
    try {
      info = await this.readPlist(posix.join(bundle, 'Contents', 'Info.plist'));
      const runningBundle = bundlePathFromExecPath(this.d.execPath);
      running = runningBundle ? plistString(await this.readPlist(posix.join(runningBundle, 'Contents', 'Info.plist')), 'CFBundleIdentifier') : undefined;
    } catch (error) { return reject(`Info.plist: ${error instanceof Error ? error.message : String(error)}`); }
    const announced = plistString(info, 'CFBundleShortVersionString');
    if (announced !== version) return reject(`version ${announced ?? '(none)'} instead of ${version}`);
    const identifier = plistString(info, 'CFBundleIdentifier');
    if (!identifier || !running || identifier !== running) return reject(`identifier ${identifier ?? '(none)'} does not match the running app`);
    const executable = plistString(info, 'CFBundleExecutable');
    if (!executable || executable.includes('/') || executable === '..' || executable === '.') return reject('no valid CFBundleExecutable');
    const exe = await this.d.fs.stat(posix.join(bundle, 'Contents', 'MacOS', executable)).catch(() => undefined);
    if (!exe?.isFile()) return reject(`the executable ${executable} is missing`);
    if (!(exe.mode & 0o111)) return reject(`the executable ${executable} is not executable`);
    const signature = await this.d.exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], EXEC_TIMEOUT_MS);
    if (signature.missing) await this.note('codesign is not available, the signature was not checked');
    else if (signature.code !== 0) return reject(`codesign: ${signature.stderr.trim().slice(0, 300)}`);
    return executable;
  }

  /**
   * Writes the swap script and the marker, then starts the script detached. The caller quits the app right after an
   * `ok` result; nothing here quits it.
   */
  async install(staged: MacStaged): Promise<MacInstallResult> {
    const { fs } = this.d;
    const target = await evaluateInstallTarget(this.d.execPath, this.d.packaged, this.targetFs());
    if (!target.ok) { await this.note(`install refused: ${target.reason}`); return { ok: false, refusal: target.reason }; }
    const writable = await probeBundleWrite(target.bundle, (path) => fs.writeFile(path, ''), (path) => fs.rm(path, { force: true }));
    if (!writable) { await this.note('install refused: the app bundle cannot be modified (App Management permission?)'); return { ok: false, refusal: 'app-management' }; }
    const exe = await fs.stat(posix.join(staged.bundle, 'Contents', 'MacOS', staged.executable)).catch(() => undefined);
    if (!exe?.isFile()) { await this.note('install aborted: the staged app is missing'); throw fail(MAC_MESSAGES.verify); }

    const backup = backupPathFor(target.bundle, this.d.currentVersion);
    const scriptPath = posix.join(this.dir, `install-${staged.version}.sh`);
    const script = buildInstallScript({
      pid: this.d.pid, bundle: target.bundle, newBundle: staged.bundle, backup, executable: staged.executable,
      log: this.logFile, readyFlag: this.readyFile, selfPath: scriptPath, cleanup: [staged.extractDir, staged.zip],
      fromVersion: this.d.currentVersion, toVersion: staged.version,
      waitSeconds: this.d.scriptWaitSeconds ?? SCRIPT_WAIT_SECONDS, readySeconds: this.d.scriptReadySeconds ?? SCRIPT_READY_SECONDS,
    });
    const marker: PendingMarker = { from: this.d.currentVersion, to: staged.version, at: this.d.now(), bundle: target.bundle, backup };
    await fs.writeFile(scriptPath, script, { mode: 0o700 });
    await fs.writeFile(this.markerFile, JSON.stringify(marker));
    const started = await this.d.spawnDetached('/bin/sh', [scriptPath]).catch(() => false);
    if (!started) {
      await fs.rm(this.markerFile, { force: true });
      await fs.rm(scriptPath, { force: true });
      await this.note('the update script could not be started');
      throw fail(MAC_MESSAGES.spawn);
    }
    await this.note(`update ${this.d.currentVersion} -> ${staged.version}: the script was started, the app quits now`);
    return { ok: true };
  }

  private async readMarker(): Promise<PendingMarker | undefined> {
    try {
      const raw = JSON.parse(await this.d.fs.readFile(this.markerFile, 'utf8')) as Partial<PendingMarker>;
      return typeof raw.from === 'string' && typeof raw.to === 'string' && typeof raw.at === 'number' && typeof raw.bundle === 'string' && typeof raw.backup === 'string'
        ? { from: raw.from, to: raw.to, at: raw.at, bundle: raw.bundle, backup: raw.backup } : undefined;
    } catch { return undefined; }
  }

  /**
   * At start: tells whether the last update took effect. A marker that targets a newer version than the one running and is
   * older than `PENDING_GRACE_MS` means the swap did not happen (the script restored the old app, or never ran): that is
   * logged and reported as a failure of that version.
   */
  async finishPrevious(): Promise<MacPreviousOutcome> {
    const marker = await this.readMarker();
    if (!marker) return { kind: 'none' };
    if (compareVersions(this.d.currentVersion, marker.to) >= 0) return { kind: 'updated', version: marker.to };
    if (this.d.now() - marker.at < PENDING_GRACE_MS && this.d.now() >= marker.at) return { kind: 'none' };
    const backupKept = await this.d.fs.stat(marker.backup).then(() => true, () => false);
    await this.note(`update ${marker.from} -> ${marker.to} did not take effect; running ${this.d.currentVersion}${backupKept ? `; the previous version is still at ${marker.backup}` : ''}`);
    await this.d.fs.rm(this.markerFile, { force: true });
    await this.cleanStaging();
    return { kind: 'failed', version: marker.to };
  }

  /** Called once the main window of the new version is up: releases the waiting script and cleans up after a finished update. */
  async markReady(): Promise<void> {
    const marker = await this.readMarker();
    if (!marker || compareVersions(this.d.currentVersion, marker.to) < 0) return;
    const { fs } = this.d;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.readyFile, this.d.currentVersion);
    await fs.rm(this.markerFile, { force: true });
    await this.note(`update ${marker.from} -> ${marker.to} is running`);
    await this.cleanStaging();
    // The script normally removes the previous version itself; this covers a script that gave up waiting.
    const parent = posix.dirname(marker.bundle);
    const prefix = `${posix.basename(marker.bundle)}.old-`;
    const names = await fs.readdir(parent).catch(() => [] as string[]);
    await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) => fs.rm(posix.join(parent, name), { recursive: true, force: true }).catch(() => {})));
  }
}
