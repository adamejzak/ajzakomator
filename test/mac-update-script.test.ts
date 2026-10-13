import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildInstallScript, shellQuote, type InstallScriptOptions } from '../src/main/macUpdate/script';

const base: InstallScriptOptions = {
  pid: 4242, bundle: '/Applications/ajzakomator.app', newBundle: '/Users/me/Library/Application Support/ajzakomator/updates/mac/extracted-0.7.0/ajzakomator.app',
  backup: '/Applications/ajzakomator.app.old-0.6.5', executable: 'ajzakomator', log: '/Users/me/Library/Application Support/ajzakomator/updates/mac/update.log',
  readyFlag: '/Users/me/Library/Application Support/ajzakomator/updates/mac/ready', failedFlag: '/Users/me/Library/Application Support/ajzakomator/updates/mac/rolled-back', selfPath: '/Users/me/Library/Application Support/ajzakomator/updates/mac/install-0.7.0.sh',
  cleanup: ['/Users/me/Library/Application Support/ajzakomator/updates/mac/extracted-0.7.0', '/Users/me/Library/Application Support/ajzakomator/updates/mac/ajzakomator-0.7.0-mac-arm64.zip'],
  fromVersion: '0.6.5', toVersion: '0.7.0',
};

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(shellQuote('plain')).toBe(`'plain'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(shellQuote(`''`)).toBe(`''\\'''\\'''`);
    expect(shellQuote('')).toBe(`''`);
  });
  it('keeps every shell metacharacter literal', () => {
    for (const value of ['$(touch x)', '`id`', '"; rm -rf / #', 'a\nb', '${HOME}', 'a b\tc', '\\', '*?[]~!#&|;<>(){}']) expect(shellQuote(value)).toBe(`'${value}'`);
  });
  it('rejects NUL', () => { expect(() => shellQuote('a\0b')).toThrow(); });
});

describe('buildInstallScript (text)', () => {
  it('waits for the pid, parks the old app, moves the new one in and restores on failure', () => {
    const script = buildInstallScript(base);
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('PID=4242');
    expect(script).toContain('kill -0 "$PID"');
    expect(script).toContain('if ! mv "$BUNDLE" "$BACKUP"');
    expect(script).toContain('if ! mv "$NEW" "$BUNDLE"');
    expect(script).toContain('restore_old');
    expect(script).toContain('remove_path()');
    expect(script).toContain('mark_failed');
    expect(script).toContain('if exists "$BUNDLE"');
    expect(script).toContain('xattr -cr "$BUNDLE"');
    expect(script).toContain('open "$BUNDLE"');
    expect(script).toContain('rm -f "$SELF"');
    expect(script).toContain(`rm -rf '/Users/me/Library/Application Support/ajzakomator/updates/mac/extracted-0.7.0'`);
    // The swap happens strictly after the wait loop, and the backup is only deleted after the new app reported ready.
    expect(script.indexOf('kill -0')).toBeLessThan(script.indexOf('mv "$BUNDLE" "$BACKUP"'));
    expect(script.indexOf('mv "$NEW" "$BUNDLE"')).toBeLessThan(script.indexOf('if ! open "$BUNDLE"'));
    expect(script.indexOf('[ ! -e "$READY" ]')).toBeLessThan(script.lastIndexOf('rm -rf "$BACKUP"'));
  });
  it('quotes hostile paths so nothing is interpreted', () => {
    const hostile = `/Users/o'neil/$(touch pwned) \`id\` "x"; rm -rf ~ & #\nline2/ajzakomator.app`;
    const script = buildInstallScript({ ...base, bundle: hostile, newBundle: `${hostile}.new`, backup: `${hostile}.old`, log: `${hostile}.log`, cleanup: [`${hostile}.zip`], executable: `exe'; id`, toVersion: `1.0.0'; id` });
    const quoted = shellQuote(hostile);
    expect(script).toContain(`BUNDLE=${quoted}\n`);
    expect(script).toContain(`rm -rf ${shellQuote(`${hostile}.zip`)}\n`);
    expect(script).toContain(`EXE=${shellQuote(`exe'; id`)}\n`);
    expect(script).toContain(`TO=${shellQuote(`1.0.0'; id`)}\n`);
    // Outside the assignments no generated line contains user data.
    const body = script.split('\n').filter((line) => !/^(BUNDLE|NEW|BACKUP|EXE|LOG|READY|SELF|FROM|TO)=/.test(line) && !line.startsWith('rm -rf \''));
    expect(body.join('\n')).not.toContain('pwned');
  });
  it('requires absolute paths and sane numbers', () => {
    expect(() => buildInstallScript({ ...base, bundle: 'ajzakomator.app' })).toThrow(/absolute/);
    expect(() => buildInstallScript({ ...base, cleanup: ['relative/dir'] })).toThrow(/absolute/);
    expect(() => buildInstallScript({ ...base, pid: 0 })).toThrow();
    expect(() => buildInstallScript({ ...base, pid: Number.NaN })).toThrow();
    expect(() => buildInstallScript({ ...base, waitSeconds: -1 })).toThrow();
    expect(() => buildInstallScript({ ...base, readySeconds: 1.5 })).toThrow();
  });
  it('uses POSIX sh only (no bash arrays, [[ ]] or process substitution)', () => {
    const script = buildInstallScript(base);
    expect(script).not.toMatch(/\[\[|<\(|\bdeclare\b|\blocal\b|function\s+\w+/);
  });
});

// ── running the script for real (needs a POSIX sh: always on macOS/Linux, Git for Windows on a developer machine) ──
// Nothing below hard-codes where mv, rm, sleep, date or kill live (/bin on macOS, /usr/bin on Linux and Git for Windows):
// the script and the stubs call tools by bare name, and every run gets the same controlled PATH.

const SH = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((candidate) => existsSync(candidate))
  : 'sh';
/** Windows path -> the form Git's sh understands. */
const posixPath = (path: string): string => process.platform === 'win32' ? path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\\/g, '/') : path;
/** The system tools, found by name on every platform (macOS keeps mv in /bin, Linux and Git for Windows in /usr/bin). */
const SYSTEM_PATH = '/usr/bin:/bin';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

interface SandboxOptions {
  /** mv refuses to move the staged bundle. */
  failMove?: boolean;
  failOpen?: boolean;
  /** rm of the installed bundle itself stops halfway (removes the executable, exits 1). */
  rmFailsOnBundle?: boolean;
  /** rm of a backup directory does nothing and fails. */
  rmFailsOnBackup?: boolean;
  /** mv of the installed bundle copies it instead of renaming (so the source stays behind). */
  mvCopiesBundle?: boolean;
}

/** Lays out an installed app, a staged update next to it and stubs for `open` / `xattr` (and optionally failing `mv` / `rm`). */
function sandbox(options: SandboxOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'macupd-'));
  roots.push(root);
  const apps = join(root, `Apps it's $(touch pwned); \`id\` & (x)`);
  const stage = join(root, 'stage dir');
  const bin = join(root, 'bin');
  const bundle = join(apps, 'ajzakomator.app');
  const newBundle = `${bundle}.new-0.7.0`;
  for (const dir of [join(bundle, 'Contents', 'MacOS'), join(newBundle, 'Contents', 'MacOS'), join(stage, 'extracted-0.7.0'), bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bundle, 'Contents', 'MacOS', 'ajzakomator'), 'old');
  writeFileSync(join(newBundle, 'Contents', 'MacOS', 'ajzakomator'), 'new', { mode: 0o755 });
  writeFileSync(join(stage, 'ajzakomator-0.7.0-mac-arm64.zip'), 'zip');
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // A stub that wraps a real tool finds it by name on SYSTEM_PATH (REAL_PATH), never by an absolute location.
  const real = (tool: string) => `PATH="$REAL_PATH"; exec ${tool} "$@"`;
  // `open` records the call and plays the new app: it reports ready like the real app does once its window is up.
  stub('open', `echo "open $1" >> "$STUB_LOG"\n${options.failOpen ? 'exit 1' : '[ -n "$MAKE_READY" ] && : > "$MAKE_READY"\nexit 0'}`);
  stub('xattr', 'echo "xattr $*" >> "$STUB_LOG"; exit 0');
  const mvRules = [
    options.failMove ? 'case "$1" in *.new-*) exit 1;; esac' : '',
    options.mvCopiesBundle ? 'case "$1" in */ajzakomator.app) PATH="$REAL_PATH"; cp -R "$1" "$2"; exit $?;; esac' : '',
  ].filter(Boolean).join('\n');
  if (mvRules) stub('mv', `${mvRules}\n${real('mv')}`);
  const rmRules = [
    options.rmFailsOnBundle ? 'case "$last" in */ajzakomator.app) PATH="$REAL_PATH"; rm -f "$last/Contents/MacOS/ajzakomator"; exit 1;; esac' : '',
    options.rmFailsOnBackup ? 'case "$last" in *.old-*) exit 1;; esac' : '',
  ].filter(Boolean).join('\n');
  if (rmRules) stub('rm', `for last; do :; done\n${rmRules}\n${real('rm')}`);
  const paths = {
    bundle, newBundle, backup: `${bundle}.old-0.6.5`,
    log: join(stage, 'update.log'), ready: join(stage, 'ready'), failed: join(stage, 'rolled-back'), self: join(stage, 'install-0.7.0.sh'), stubLog: join(root, 'stub.log'),
    extractDir: join(stage, 'extracted-0.7.0'), zip: join(stage, 'ajzakomator-0.7.0-mac-arm64.zip'),
  };
  const build = (over: Partial<InstallScriptOptions> = {}) => buildInstallScript({
    pid: 999999, bundle: posixPath(paths.bundle), newBundle: posixPath(paths.newBundle), backup: posixPath(paths.backup), executable: 'ajzakomator',
    log: posixPath(paths.log), readyFlag: posixPath(paths.ready), failedFlag: posixPath(paths.failed), selfPath: posixPath(paths.self),
    cleanup: [posixPath(paths.extractDir), posixPath(paths.zip)],
    fromVersion: '0.6.5', toVersion: '0.7.0', waitSeconds: 1, readySeconds: 1, ...over,
  });
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env, PATH: `${posixPath(bin)}:${SYSTEM_PATH}`, REAL_PATH: SYSTEM_PATH, STUB_LOG: posixPath(paths.stubLog), ...extra,
  });
  const run = (text: string, extra: Record<string, string> = {}) => {
    writeFileSync(paths.self, text, { mode: 0o755 });
    return spawnSync(SH!, [posixPath(paths.self)], { cwd: root, encoding: 'utf8', timeout: 30_000, env: env(extra) });
  };
  const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : '';
  const oldExe = (dir: string) => read(join(dir, 'Contents', 'MacOS', 'ajzakomator'));
  const opens = () => read(paths.stubLog).split('\n').filter((line) => line.startsWith('open ')).length;
  return { root, paths, build, run, env, read, oldExe, opens };
}

describe.skipIf(!SH)('buildInstallScript (executed)', () => {
  it('swaps the app, removes the quarantine, starts it and cleans up once the new app is ready', () => {
    const box = sandbox();
    const result = box.run(box.build(), { MAKE_READY: posixPath(box.paths.ready) });
    expect(result.status).toBe(0);
    expect(box.oldExe(box.paths.bundle)).toBe('new');
    expect(existsSync(box.paths.newBundle)).toBe(false);
    expect(existsSync(box.paths.backup)).toBe(false);
    expect(existsSync(box.paths.extractDir)).toBe(false);
    expect(existsSync(box.paths.zip)).toBe(false);
    expect(existsSync(box.paths.self)).toBe(false);
    expect(existsSync(box.paths.failed)).toBe(false);
    expect(existsSync(join(box.root, 'pwned'))).toBe(false);
    expect(box.read(box.paths.stubLog)).toContain(`xattr -cr ${posixPath(box.paths.bundle)}`);
    expect(box.read(box.paths.stubLog)).toContain(`open ${posixPath(box.paths.bundle)}`);
    expect(box.read(box.paths.log)).toContain('update 0.6.5 -> 0.7.0 complete');
  });
  it('keeps the previous version when the new app never reports ready', () => {
    const box = sandbox();
    const result = box.run(box.build());
    expect(result.status).toBe(0);
    expect(box.oldExe(box.paths.bundle)).toBe('new');
    expect(box.oldExe(box.paths.backup)).toBe('old');
    expect(box.read(box.paths.log)).toContain('did not report ready');
    expect(existsSync(box.paths.self)).toBe(false);
  });
  it('restores the old app, starts it and flags the failure when the new one cannot be moved into place', () => {
    const box = sandbox({ failMove: true });
    const result = box.run(box.build());
    expect(result.status).toBe(1);
    expect(box.oldExe(box.paths.bundle)).toBe('old');
    expect(existsSync(box.paths.backup)).toBe(false);
    expect(existsSync(join(box.paths.bundle, 'ajzakomator.app.old-0.6.5'))).toBe(false);
    expect(box.read(box.paths.log)).toContain('restoring the previous version');
    expect(box.read(box.paths.log)).toContain('previous version was restored');
    expect(box.read(box.paths.stubLog)).toContain(`open ${posixPath(box.paths.bundle)}`);
    expect(box.read(box.paths.failed).trim()).toBe('0.7.0');
    // The staged files stay for a later attempt.
    expect(existsSync(box.paths.newBundle)).toBe(true);
  });
  it('restores the old app when the new one cannot be opened', () => {
    const box = sandbox({ failOpen: true });
    const result = box.run(box.build());
    expect(result.status).toBe(1);
    expect(box.oldExe(box.paths.bundle)).toBe('old');
    expect(existsSync(box.paths.backup)).toBe(false);
    expect(box.read(box.paths.log)).toContain('could not be opened');
    expect(box.read(box.paths.failed).trim()).toBe('0.7.0');
  });
  it('changes nothing, relaunches the old app and flags the failure when the staged bundle is missing', () => {
    const box = sandbox();
    rmSync(box.paths.newBundle, { recursive: true, force: true });
    const result = box.run(box.build());
    expect(result.status).toBe(1);
    expect(box.oldExe(box.paths.bundle)).toBe('old');
    expect(existsSync(box.paths.backup)).toBe(false);
    expect(box.read(box.paths.log)).toContain('staged app is missing');
    expect(box.read(box.paths.failed).trim()).toBe('0.7.0');
  });
  it('reports a failed rollback and never nests the old app inside a half-removed new one', () => {
    // The new app is in place but cannot be opened; removing it for the rollback stops halfway and fails.
    const box = sandbox({ failOpen: true, rmFailsOnBundle: true });
    const result = box.run(box.build());
    expect(result.status).toBe(1);
    const log = box.read(box.paths.log);
    expect(log).toContain('ROLLBACK FAILED');
    expect(log).toContain('the previous version is at');
    expect(log).not.toContain('previous version was restored');
    // The old app is intact in its backup place and was not moved into the leftover directory.
    expect(box.oldExe(box.paths.backup)).toBe('old');
    expect(existsSync(join(box.paths.bundle, 'ajzakomator.app.old-0.6.5'))).toBe(false);
    expect(existsSync(join(box.paths.bundle, 'ajzakomator.app'))).toBe(false);
    // The old app is not started, and the failure is still flagged.
    expect(box.opens()).toBe(1);
    expect(box.read(box.paths.failed).trim()).toBe('0.7.0');
  });
  it('refuses to start when an older backup cannot be removed, with the old app untouched', () => {
    const box = sandbox({ rmFailsOnBackup: true });
    mkdirSync(join(box.paths.backup, 'Contents'), { recursive: true });
    writeFileSync(join(box.paths.backup, 'Contents', 'stale'), 'x');
    const result = box.run(box.build());
    expect(result.status).toBe(1);
    expect(box.oldExe(box.paths.bundle)).toBe('old');
    expect(existsSync(join(box.paths.backup, 'ajzakomator.app'))).toBe(false);
    expect(existsSync(box.paths.newBundle)).toBe(true);
    expect(box.read(box.paths.log)).toContain('earlier backup could not be removed');
    expect(box.read(box.paths.failed).trim()).toBe('0.7.0');
  });
  it('rolls back when the old app is still in place after being "moved" aside', () => {
    const box = sandbox({ mvCopiesBundle: true });
    const result = box.run(box.build());
    expect(result.status).toBe(1);
    expect(box.oldExe(box.paths.bundle)).toBe('old');
    expect(existsSync(box.paths.backup)).toBe(false);
    expect(existsSync(join(box.paths.bundle, 'ajzakomator.app.old-0.6.5'))).toBe(false);
    expect(existsSync(join(box.paths.bundle, 'ajzakomator.app.new-0.7.0'))).toBe(false);
    expect(box.read(box.paths.log)).toContain('still in place');
    expect(box.read(box.paths.failed).trim()).toBe('0.7.0');
  });
  it('gives up without touching anything while the app is still running', () => {
    const box = sandbox();
    // The stand-in for the running app and the script share one shell session, so `kill -0` sees its pid on every platform.
    const text = box.build({ pid: 4242 }).replace('PID=4242\n', 'PID=$HOLDER\n');
    expect(text).toContain('PID=$HOLDER');
    writeFileSync(box.paths.self, text, { mode: 0o755 });
    const wrapper = 'sleep 30 & HOLDER=$!; export HOLDER; sh "$0"; status=$?; kill $HOLDER; exit $status';
    const result = spawnSync(SH!, ['-c', wrapper, posixPath(box.paths.self)], { cwd: box.root, encoding: 'utf8', timeout: 30_000, env: box.env() });
    expect(result.status).toBe(1);
    expect(box.oldExe(box.paths.bundle)).toBe('old');
    expect(existsSync(box.paths.backup)).toBe(false);
    expect(box.read(box.paths.log)).toContain('still running');
    expect(box.read(box.paths.stubLog)).not.toContain('open ');
    expect(existsSync(box.paths.failed)).toBe(false);
  });
});
