import { createHash } from 'crypto';
import { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { MAC_MESSAGES, MacUpdater, plistString, type ExecResult, type MacOffer, type MacUpdaterDeps } from '../src/main/macUpdate/engine';

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

const APP = '/Applications/ajzakomator.app';
const EXEC = `${APP}/Contents/MacOS/ajzakomator`;
const DIR = '/Users/me/Library/Application Support/ajzakomator/updates/mac';
const ZIP_NAME = 'ajzakomator-0.7.0-mac-arm64.zip';
const PAYLOAD = Buffer.from('pretend this is a 140 MB zip archive');
const sha512 = (data: Uint8Array) => createHash('sha512').update(data).digest('base64');

const feedYml = (version = '0.7.0', zipBytes: Uint8Array = PAYLOAD, arch = 'arm64') => `version: ${version}
files:
  - url: ajzakomator-${version}-mac-${arch}.zip
    sha512: >-
      ${sha512(zipBytes)}
    size: ${zipBytes.length}
  - url: ajzakomator-${version}-mac-${arch}.dmg
    sha512: >-
      AAAA
    size: 99
path: ajzakomator-${version}-mac-x64.zip
`;

const plist = (values: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${Object.entries(values).map(([k, v]) => `<key>${k}</key>\n<string>${v}</string>`).join('\n')}</dict></plist>`;
const INFO = { CFBundleIdentifier: 'com.ajzakomator.app', CFBundleShortVersionString: '0.7.0', CFBundleExecutable: 'ajzakomator' };

type Entry = { data: Buffer; mode: number };
/** A tiny in-memory file system with just what the updater uses; paths are plain strings. */
function memFs(uid = 501) {
  const files = new Map<string, Entry>();
  const dirs = new Set<string>();
  const denied = new Map<string, string>();
  const err = (code: string) => Object.assign(new Error(code), { code });
  const isDir = (p: string) => dirs.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`));
  const put = (p: string, data: string | Uint8Array, mode = 0o644) => { files.set(p, { data: Buffer.from(data), mode }); };
  const fs = {
    mkdir: async (p: string) => { dirs.add(p); return undefined; },
    readdir: async (p: string) => {
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) if (key.startsWith(`${p}/`)) names.add(key.slice(p.length + 1).split('/')[0]);
      return [...names];
    },
    rm: async (p: string) => {
      for (const key of [...files.keys()]) if (key === p || key.startsWith(`${p}/`)) files.delete(key);
      for (const key of [...dirs]) if (key === p || key.startsWith(`${p}/`)) dirs.delete(key);
    },
    stat: async (p: string) => {
      const file = files.get(p);
      if (file) return { size: file.data.length, uid, mode: file.mode, isFile: () => true, isDirectory: () => false };
      if (isDir(p)) return { size: 0, uid, mode: 0o755, isFile: () => false, isDirectory: () => true };
      throw err('ENOENT');
    },
    writeFile: async (p: string, data: string | Uint8Array, options?: { mode?: number }) => {
      if (denied.get('write') && p.endsWith('.ajzakomator-write-probe')) throw err(denied.get('write')!);
      put(p, data, options?.mode ?? 0o644);
    },
    appendFile: async (p: string, data: string) => { put(p, Buffer.concat([files.get(p)?.data ?? Buffer.alloc(0), Buffer.from(data)])); },
    readFile: async (p: string) => { const file = files.get(p); if (!file) throw err('ENOENT'); return file.data.toString('utf8'); },
    rename: async (from: string, to: string) => { const file = files.get(from); if (!file) throw err('ENOENT'); files.set(to, file); files.delete(from); },
    access: async (p: string) => { const code = denied.get(p); if (code) throw err(code); },
    open: async (p: string, flags: string) => {
      if (flags === 'w') {
        put(p, Buffer.alloc(0));
        return { write: async (chunk: Uint8Array) => { put(p, Buffer.concat([files.get(p)!.data, Buffer.from(chunk)])); }, close: async () => {} };
      }
      const file = files.get(p);
      if (!file) throw err('ENOENT');
      return { createReadStream: () => Readable.from([file.data]), close: async () => {} };
    },
  };
  return { fs: fs as unknown as MacUpdaterDeps['fs'], files, dirs, denied, put, text: (p: string) => files.get(p)?.data.toString('utf8') };
}

const bodyStream = (data: Buffer, chunk = 7, signal?: AbortSignal) => new ReadableStream<Uint8Array>({
  start(controller) {
    signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    for (let i = 0; i < data.length; i += chunk) controller.enqueue(new Uint8Array(data.subarray(i, i + chunk)));
    controller.close();
  },
});
/** Never delivers anything after the first chunk, like a connection that went silent. */
const silentStream = (signal?: AbortSignal) => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]));
    signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
  },
});

interface Harness { updater: MacUpdater; mem: ReturnType<typeof memFs>; deps: MacUpdaterDeps; exec: ReturnType<typeof vi.fn>; spawned: Array<[string, string[]]>; urls: string[]; setNow(ms: number): void }
function harness(over: Partial<MacUpdaterDeps> & { zip?: Buffer; feed?: string; codesign?: Partial<ExecResult>; ditto?: Partial<ExecResult>; unpacked?: Record<string, string>; runningInfo?: Record<string, string> } = {}): Harness {
  const mem = memFs();
  const zip = over.zip ?? PAYLOAD;
  mem.put(`${APP}/Contents/Info.plist`, plist({ ...INFO, CFBundleShortVersionString: '0.6.5', ...over.runningInfo }));
  mem.dirs.add(APP); mem.dirs.add('/Applications');
  let clock = 1_000_000;
  const urls: string[] = [];
  const spawned: Array<[string, string[]]> = [];
  const exec = vi.fn(async (command: string, args: string[]): Promise<ExecResult> => {
    if (command === '/usr/bin/ditto') {
      if (over.ditto) return { code: 1, stdout: '', stderr: 'ditto: bad archive', ...over.ditto };
      const target = args[args.length - 1];
      const info = { ...INFO, ...over.unpacked };
      mem.put(`${target}/ajzakomator.app/Contents/Info.plist`, plist(info));
      mem.put(`${target}/ajzakomator.app/Contents/MacOS/${info.CFBundleExecutable}`, 'binary', 0o755);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/codesign') return { code: 0, stdout: '', stderr: '', ...over.codesign };
    return { code: 0, stdout: '', stderr: '' };
  });
  const deps: MacUpdaterDeps = {
    arch: 'arm64', currentVersion: '0.6.5', execPath: EXEC, pid: 4242, packaged: true, updateDir: DIR,
    feedUrl: 'https://feed.test/latest-mac.yml', assetBase: (version) => `https://downloads.test/v${version}/`,
    fetch: async (url, init) => {
      urls.push(url);
      if (url.endsWith('latest-mac.yml')) return new Response(over.feed ?? feedYml('0.7.0', zip), { status: 200 });
      return new Response(bodyStream(zip, 7, init.signal as AbortSignal), { status: 200 });
    },
    fs: mem.fs, exec, spawnDetached: async (command, args) => { spawned.push([command, args]); return true; },
    uid: () => 501, now: () => clock, ...over,
  };
  return { updater: new MacUpdater(deps), mem, deps, exec, spawned, urls, setNow: (ms) => { clock = ms; } };
}

const offerOf = async (h: Harness): Promise<MacOffer> => { const { offer } = await h.updater.check(); expect(offer).toBeDefined(); return offer!; };

// ── tests ──────────────────────────────────────────────────────────────────────────────────────

describe('plistString', () => {
  it('reads string values and decodes entities', () => {
    expect(plistString(plist({ A: 'x &amp; y', B: '1.0' }), 'A')).toBe('x & y');
    expect(plistString(plist({ A: 'x' }), 'Missing')).toBeUndefined();
    expect(plistString(plist({ 'a.b': 'dot' }), 'a.b')).toBe('dot');
  });
});

describe('MacUpdater.check', () => {
  it('offers the newer version with the archive of this architecture and the announced hash', async () => {
    const h = harness();
    const { latest, offer } = await h.updater.check();
    expect(latest).toBe('0.7.0');
    expect(offer).toMatchObject({ version: '0.7.0', url: `https://downloads.test/v0.7.0/${ZIP_NAME}`, asset: { name: ZIP_NAME, sha512: sha512(PAYLOAD), size: PAYLOAD.length } });
    expect(offer?.refusal).toBeUndefined();
  });
  it('picks the x64 archive on Intel', async () => {
    const h = harness({ arch: 'x64', feed: feedYml('0.7.0', PAYLOAD, 'x64') });
    expect((await offerOf(h)).asset.name).toBe('ajzakomator-0.7.0-mac-x64.zip');
  });
  it('reports "current" for the same or an older version', async () => {
    expect(await harness({ feed: feedYml('0.6.5') }).updater.check()).toEqual({ latest: '0.6.5' });
    expect(await harness({ feed: feedYml('0.6.4') }).updater.check()).toEqual({ latest: '0.6.4' });
  });
  it('fails clearly when the feed has no archive for this architecture, or the server errors', async () => {
    await expect(harness({ arch: 'arm64', feed: feedYml('0.7.0', PAYLOAD, 'x64') }).updater.check()).rejects.toThrow(MAC_MESSAGES.noAsset);
    const broken = harness({ fetch: async () => new Response('nope', { status: 503 }) });
    await expect(broken.updater.check()).rejects.toThrow(MAC_MESSAGES.server);
  });
  it('flags an offer the app cannot install itself and says why (no download is needed for that)', async () => {
    const h = harness({ execPath: '/Volumes/ajzakomator 0.6.5/ajzakomator.app/Contents/MacOS/ajzakomator' });
    h.mem.denied.set('/Volumes/ajzakomator 0.6.5', 'EROFS');
    expect((await offerOf(h)).refusal).toBe('read-only');
    expect(h.mem.text(`${DIR}/update.log`)).toContain('read-only');
    expect((await offerOf(harness({ packaged: false }))).refusal).toBe('not-bundle');
  });
});

describe('MacUpdater.download', () => {
  it('downloads, verifies size and sha512, unpacks with ditto and checks the bundle', async () => {
    const h = harness();
    const progress = vi.fn();
    const staged = await h.updater.download(await offerOf(h), progress);
    expect(staged).toMatchObject({ version: '0.7.0', bundle: `${DIR}/extracted-0.7.0/ajzakomator.app`, executable: 'ajzakomator', zip: `${DIR}/${ZIP_NAME}` });
    expect(h.mem.files.get(`${DIR}/${ZIP_NAME}`)?.data.equals(PAYLOAD)).toBe(true);
    expect(h.mem.files.has(`${DIR}/${ZIP_NAME}.part`)).toBe(false);
    expect(h.exec).toHaveBeenCalledWith('/usr/bin/ditto', ['-x', '-k', `${DIR}/${ZIP_NAME}`, `${DIR}/extracted-0.7.0`], expect.any(Number));
    expect(h.exec).toHaveBeenCalledWith('/usr/bin/xattr', ['-cr', staged.bundle], expect.any(Number));
    expect(h.exec).toHaveBeenCalledWith('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged.bundle], expect.any(Number));
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ percent: 100, transferred: PAYLOAD.length, total: PAYLOAD.length }));
  });
  it('reports growing progress while the data arrives', async () => {
    const h = harness();
    let clock = 0;
    h.deps.now = () => (clock += 300);
    const percents: number[] = [];
    await new MacUpdater(h.deps).download(await offerOf(h), (p) => percents.push(p.percent));
    expect(percents.length).toBeGreaterThan(2);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(percents.at(-1)).toBe(100);
  });
  it('rejects data with the wrong checksum and removes the partial file', async () => {
    const h = harness();
    const offer = await offerOf(h);
    h.deps.fetch = async (_url, init) => new Response(bodyStream(Buffer.from('X'.repeat(PAYLOAD.length)), 7, init.signal as AbortSignal), { status: 200 });
    await expect(new MacUpdater(h.deps).download(offer, vi.fn())).rejects.toThrow(MAC_MESSAGES.damaged);
    expect([...h.mem.files.keys()].filter((key) => key.includes('.zip'))).toEqual([]);
    expect(h.exec).not.toHaveBeenCalledWith('/usr/bin/ditto', expect.anything(), expect.anything());
  });
  it('rejects a truncated or oversized download', async () => {
    const h = harness();
    const offer = await offerOf(h);
    h.deps.fetch = async (_url, init) => new Response(bodyStream(PAYLOAD.subarray(0, 10), 7, init.signal as AbortSignal), { status: 200 });
    await expect(new MacUpdater(h.deps).download(offer, vi.fn())).rejects.toThrow(MAC_MESSAGES.damaged);
    h.deps.fetch = async (_url, init) => new Response(bodyStream(Buffer.concat([PAYLOAD, Buffer.from('more')]), 7, init.signal as AbortSignal), { status: 200 });
    await expect(new MacUpdater(h.deps).download(offer, vi.fn())).rejects.toThrow(MAC_MESSAGES.damaged);
    expect([...h.mem.files.keys()].filter((key) => key.includes('.zip'))).toEqual([]);
  });
  it('fails when the server answers with an error', async () => {
    const h = harness();
    const offer = await offerOf(h);
    h.deps.fetch = async () => new Response('gone', { status: 404 });
    await expect(new MacUpdater(h.deps).download(offer, vi.fn())).rejects.toThrow(MAC_MESSAGES.server);
  });
  it('gives up on a download that goes silent', async () => {
    const h = harness({ stallMs: 40 });
    const offer = await offerOf(h);
    h.deps.fetch = async (_url, init) => new Response(silentStream(init.signal as AbortSignal), { status: 200 });
    await expect(new MacUpdater(h.deps).download(offer, vi.fn())).rejects.toThrow(MAC_MESSAGES.stalled);
    expect([...h.mem.files.keys()].some((key) => key.endsWith('.part'))).toBe(false);
  });
  it('reuses an archive that is already on disk and still verifies, without downloading again', async () => {
    const h = harness();
    const offer = await offerOf(h);
    await h.updater.download(offer, vi.fn());
    h.urls.length = 0;
    await h.updater.download(offer, vi.fn());
    expect(h.urls).toEqual([]);
  });
  it('downloads again when the archive on disk is damaged, and deletes stale files of other versions', async () => {
    const h = harness();
    const offer = await offerOf(h);
    h.mem.put(`${DIR}/${ZIP_NAME}`, 'damaged');
    h.mem.put(`${DIR}/ajzakomator-0.6.9-mac-arm64.zip`, 'old');
    h.mem.put(`${DIR}/install-0.6.9.sh`, '#!/bin/sh');
    await h.updater.download(offer, vi.fn());
    expect(h.urls).toContain(offer.url);
    expect(h.mem.files.has(`${DIR}/ajzakomator-0.6.9-mac-arm64.zip`)).toBe(false);
    expect(h.mem.files.has(`${DIR}/install-0.6.9.sh`)).toBe(false);
  });
  it('treats a failing ditto as a failed update', async () => {
    const h = harness({ ditto: { code: 1 } });
    await expect(h.updater.download(await offerOf(h), vi.fn())).rejects.toThrow(MAC_MESSAGES.extract);
    expect(h.mem.text(`${DIR}/update.log`)).toContain('ditto failed');
  });

  describe('bundle verification', () => {
    const failing = async (over: Parameters<typeof harness>[0]) => {
      const h = harness(over);
      await expect(h.updater.download(await offerOf(h), vi.fn())).rejects.toThrow(MAC_MESSAGES.verify);
      return h;
    };
    it('rejects another version inside the archive', async () => {
      expect((await failing({ unpacked: { CFBundleShortVersionString: '0.6.9' } })).mem.text(`${DIR}/update.log`)).toContain('version 0.6.9 instead of 0.7.0');
    });
    it('rejects another bundle identifier than the running app', async () => {
      expect((await failing({ unpacked: { CFBundleIdentifier: 'com.evil.app' } })).mem.text(`${DIR}/update.log`)).toContain('identifier com.evil.app');
    });
    it('rejects a bundle whose executable is missing, not executable or has a path in its name', async () => {
      await failing({ unpacked: { CFBundleExecutable: '../../escape' } });
      const h = harness();
      const offer = await offerOf(h);
      h.exec.mockImplementationOnce(async (_c: string, args: string[]) => { h.mem.put(`${args[3]}/ajzakomator.app/Contents/Info.plist`, plist(INFO)); return { code: 0, stdout: '', stderr: '' }; });
      await expect(h.updater.download(offer, vi.fn())).rejects.toThrow(MAC_MESSAGES.verify);
      expect(h.mem.text(`${DIR}/update.log`)).toContain('executable ajzakomator is missing');
    });
    it('rejects an executable without the execute permission', async () => {
      const h = harness();
      const offer = await offerOf(h);
      h.exec.mockImplementationOnce(async (_c: string, args: string[]) => {
        h.mem.put(`${args[3]}/ajzakomator.app/Contents/Info.plist`, plist(INFO));
        h.mem.put(`${args[3]}/ajzakomator.app/Contents/MacOS/ajzakomator`, 'x', 0o644);
        return { code: 0, stdout: '', stderr: '' };
      });
      await expect(h.updater.download(offer, vi.fn())).rejects.toThrow(MAC_MESSAGES.verify);
      expect(h.mem.text(`${DIR}/update.log`)).toContain('is not executable');
    });
    it('rejects a failing code signature check', async () => {
      expect((await failing({ codesign: { code: 1, stderr: 'a sealed resource is missing or invalid' } })).mem.text(`${DIR}/update.log`)).toContain('a sealed resource is missing');
    });
    it('continues (and says so) when codesign is not available', async () => {
      const h = harness({ codesign: { code: null, missing: true } });
      await h.updater.download(await offerOf(h), vi.fn());
      expect(h.mem.text(`${DIR}/update.log`)).toContain('codesign is not available');
    });
    it('rejects an archive with no or several app bundles', async () => {
      const h = harness();
      const offer = await offerOf(h);
      h.exec.mockImplementationOnce(async (_c: string, args: string[]) => { h.mem.put(`${args[3]}/readme.txt`, 'hi'); return { code: 0, stdout: '', stderr: '' }; });
      await expect(h.updater.download(offer, vi.fn())).rejects.toThrow(MAC_MESSAGES.verify);
    });
    it('reads a binary Info.plist through plutil', async () => {
      const h = harness();
      const offer = await offerOf(h);
      h.exec.mockImplementation(async (command: string, args: string[]) => {
        if (command === '/usr/bin/ditto') {
          h.mem.put(`${args[3]}/ajzakomator.app/Contents/Info.plist`, 'bplist00binary');
          h.mem.put(`${args[3]}/ajzakomator.app/Contents/MacOS/ajzakomator`, 'x', 0o755);
        }
        if (command === '/usr/bin/plutil') return { code: 0, stdout: plist(INFO), stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      });
      await expect(h.updater.download(offer, vi.fn())).resolves.toMatchObject({ version: '0.7.0' });
      expect(h.exec).toHaveBeenCalledWith('/usr/bin/plutil', expect.arrayContaining(['-convert', 'xml1']), expect.any(Number));
    });
  });
});

describe('MacUpdater.install', () => {
  const staged = async (h: Harness) => h.updater.download(await offerOf(h), vi.fn());

  it('writes the swap script and a marker, then starts the script detached through /bin/sh', async () => {
    const h = harness();
    const s = await staged(h);
    expect(await h.updater.install(s)).toEqual({ ok: true });
    const scriptPath = `${DIR}/install-0.7.0.sh`;
    const script = h.mem.text(scriptPath)!;
    expect(script).toContain(`BUNDLE='${APP}'`);
    expect(script).toContain(`BACKUP='${APP}.old-0.6.5'`);
    expect(script).toContain(`NEW='${s.bundle}'`);
    expect(script).toContain('PID=4242');
    expect(h.mem.files.get(scriptPath)?.mode).toBe(0o700);
    expect(h.spawned).toEqual([['/bin/sh', [scriptPath]]]);
    expect(JSON.parse(h.mem.text(`${DIR}/pending.json`)!)).toMatchObject({ from: '0.6.5', to: '0.7.0', bundle: APP, backup: `${APP}.old-0.6.5` });
    // The probe file is gone again.
    expect([...h.mem.files.keys()].some((key) => key.endsWith('.ajzakomator-write-probe'))).toBe(false);
  });
  it('refuses (and starts nothing) when the app can no longer be replaced', async () => {
    const h = harness();
    const s = await staged(h);
    h.mem.denied.set('/Applications', 'EACCES');
    expect(await h.updater.install(s)).toEqual({ ok: false, refusal: 'not-writable' });
    expect(h.spawned).toEqual([]);
    expect(h.mem.files.has(`${DIR}/pending.json`)).toBe(false);
  });
  it('refuses when macOS denies writing into the bundle (App Management)', async () => {
    const h = harness();
    const s = await staged(h);
    h.mem.denied.set('write', 'EPERM');
    expect(await h.updater.install(s)).toEqual({ ok: false, refusal: 'app-management' });
    expect(h.spawned).toEqual([]);
  });
  it('refuses an app owned by someone else', async () => {
    const h = harness({ uid: () => 777 });
    const s = await staged(h);
    expect(await h.updater.install(s)).toEqual({ ok: false, refusal: 'not-owner' });
  });
  it('fails and leaves no marker when the script cannot be started', async () => {
    const h = harness({ spawnDetached: async () => false });
    const s = await staged(h);
    await expect(h.updater.install(s)).rejects.toThrow(MAC_MESSAGES.spawn);
    expect(h.mem.files.has(`${DIR}/pending.json`)).toBe(false);
    expect(h.mem.files.has(`${DIR}/install-0.7.0.sh`)).toBe(false);
  });
  it('aborts when the staged app disappeared', async () => {
    const h = harness();
    const s = await staged(h);
    await h.mem.fs.rm(s.bundle, { recursive: true, force: true });
    await expect(h.updater.install(s)).rejects.toThrow(MAC_MESSAGES.verify);
    expect(h.spawned).toEqual([]);
  });
  it('survives paths with spaces and quotes in the app location', async () => {
    const exec = "/Users/o'neil/My Apps/ajzakomator.app/Contents/MacOS/ajzakomator";
    const h = harness({ execPath: exec });
    h.mem.put("/Users/o'neil/My Apps/ajzakomator.app/Contents/Info.plist", plist(INFO));
    const s = await staged(h);
    expect(await h.updater.install(s)).toEqual({ ok: true });
    expect(h.mem.text(`${DIR}/install-0.7.0.sh`)).toContain(`BUNDLE='/Users/o'\\''neil/My Apps/ajzakomator.app'`);
  });
});

describe('MacUpdater after the swap', () => {
  const marker = (over: Record<string, unknown> = {}) => JSON.stringify({ from: '0.6.5', to: '0.7.0', at: 1_000_000, bundle: APP, backup: `${APP}.old-0.6.5`, ...over });

  it('has nothing to report without a marker', async () => {
    expect(await harness().updater.finishPrevious()).toEqual({ kind: 'none' });
  });
  it('recognises a finished update, releases the waiting script and cleans up', async () => {
    const h = harness({ currentVersion: '0.7.0' });
    h.mem.put(`${DIR}/pending.json`, marker());
    h.mem.put(`${DIR}/${ZIP_NAME}`, 'zip');
    h.mem.put(`${DIR}/update.log`, 'log');
    h.mem.put(`${APP}.old-0.6.5/Contents/Info.plist`, 'x');
    h.mem.put(`${APP}.old-0.6.4/Contents/Info.plist`, 'x');
    expect(await h.updater.finishPrevious()).toEqual({ kind: 'updated', version: '0.7.0' });
    await h.updater.markReady();
    expect(h.mem.text(`${DIR}/ready`)).toBe('0.7.0');
    expect(h.mem.files.has(`${DIR}/pending.json`)).toBe(false);
    expect(h.mem.files.has(`${DIR}/${ZIP_NAME}`)).toBe(false);
    expect(h.mem.files.has(`${APP}.old-0.6.5/Contents/Info.plist`)).toBe(false);
    expect(h.mem.files.has(`${APP}.old-0.6.4/Contents/Info.plist`)).toBe(false);
    expect(h.mem.text(`${DIR}/update.log`)).toContain('update 0.6.5 -> 0.7.0 is running');
  });
  it('markReady does nothing for an app that was not just updated', async () => {
    const h = harness();
    await h.updater.markReady();
    expect(h.mem.files.has(`${DIR}/ready`)).toBe(false);
    const old = harness({ currentVersion: '0.6.5' });
    old.mem.put(`${DIR}/pending.json`, marker());
    await old.updater.markReady();
    expect(old.mem.files.has(`${DIR}/ready`)).toBe(false);
  });
  it('reports a swap that did not happen (old version still running) once the script had time, and notes the backup', async () => {
    const h = harness();
    h.setNow(1_000_000 + 3 * 60 * 1000);
    h.mem.put(`${DIR}/pending.json`, marker());
    h.mem.put(`${APP}.old-0.6.5/Contents/Info.plist`, 'x');
    expect(await h.updater.finishPrevious()).toEqual({ kind: 'failed', version: '0.7.0' });
    expect(h.mem.files.has(`${DIR}/pending.json`)).toBe(false);
    const log = h.mem.text(`${DIR}/update.log`)!;
    expect(log).toContain('update 0.6.5 -> 0.7.0 did not take effect; running 0.6.5');
    expect(log).toContain(`the previous version is still at ${APP}.old-0.6.5`);
  });
  it('leaves a fresh marker alone (the script may still be working)', async () => {
    const h = harness();
    h.setNow(1_000_000 + 10_000);
    h.mem.put(`${DIR}/pending.json`, marker());
    expect(await h.updater.finishPrevious()).toEqual({ kind: 'none' });
    expect(h.mem.files.has(`${DIR}/pending.json`)).toBe(true);
  });
  it('ignores a corrupt marker', async () => {
    const h = harness();
    h.mem.put(`${DIR}/pending.json`, '{not json');
    expect(await h.updater.finishPrevious()).toEqual({ kind: 'none' });
  });
  it('keeps the update log small', async () => {
    const h = harness();
    h.mem.put(`${DIR}/update.log`, 'x'.repeat(150 * 1024));
    await h.updater.note('fresh line');
    expect(h.mem.text(`${DIR}/update.log`)).toMatch(/fresh line\n$/);
    expect(h.mem.text(`${DIR}/update.log`)!.length).toBeLessThan(1024);
  });
});
