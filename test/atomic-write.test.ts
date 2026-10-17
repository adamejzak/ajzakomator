import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteFileSync, isTransientFsError, tempPathFor, type AtomicWriteFs } from '../src/main/atomicWrite';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-atomic-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const codeError = (code: string) => Object.assign(new Error(code), { code });

/** The real file system, with a rename that fails `failures` times with `code` first. */
function flakyRename(code: string, failures: number): AtomicWriteFs & { renames: number } {
  const seam = {
    renames: 0,
    openSync: fs.openSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync,
    writeSync: (fd: number, data: Buffer) => fs.writeSync(fd, data),
    rmSync: (path: string) => fs.rmSync(path, { force: true }),
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      seam.renames++;
      if (seam.renames <= failures) throw codeError(code);
      fs.renameSync(from, to);
    },
  };
  return seam;
}

describe('atomicWriteFileSync', () => {
  it('writes the file and leaves no temp file behind', () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, 'old');
    atomicWriteFileSync(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('retries a rename that hits a Windows file lock, with a growing backoff', () => {
    const file = join(dir, 'state.json');
    const seam = flakyRename('EBUSY', 3);
    const sleep = vi.fn();
    atomicWriteFileSync(file, 'new', { fs: seam, sleep });
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(seam.renames).toBe(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([20, 40, 80]);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('gives up after the retries and removes its temp file', () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, 'kept');
    const seam = flakyRename('EPERM', 100);
    expect(() => atomicWriteFileSync(file, 'new', { fs: seam, sleep: () => {}, retries: 2 })).toThrow('EPERM');
    expect(seam.renames).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe('kept');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('does not retry errors that are not transient', () => {
    const seam = flakyRename('ENOSPC', 1);
    const sleep = vi.fn();
    expect(() => atomicWriteFileSync(join(dir, 'x.json'), 'new', { fs: seam, sleep })).toThrow('ENOSPC');
    expect(sleep).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('flushes the temp file to disk before the rename unless told not to', () => {
    const order: string[] = [];
    const seam: AtomicWriteFs = {
      openSync: fs.openSync, closeSync: fs.closeSync, rmSync: (p) => fs.rmSync(p, { force: true }),
      writeSync: (fd, data) => { order.push('write'); return fs.writeSync(fd, data); },
      fsyncSync: (fd) => { order.push('fsync'); fs.fsyncSync(fd); },
      renameSync: (a, b) => { order.push('rename'); fs.renameSync(a, b); },
    };
    atomicWriteFileSync(join(dir, 'a.json'), 'x', { fs: seam });
    expect(order).toEqual(['write', 'fsync', 'rename']);
    order.length = 0;
    atomicWriteFileSync(join(dir, 'b.json'), 'x', { fs: seam, fsync: false });
    expect(order).toEqual(['write', 'rename']);
  });

  it('uses a temp name no other writer shares', () => {
    const file = join(dir, 'state.json');
    expect(tempPathFor(file)).not.toBe(tempPathFor(file));
    expect(tempPathFor(file)).toContain(`.${process.pid}.`);
  });

  it('knows which error codes are transient', () => {
    expect(['EPERM', 'EBUSY', 'EACCES'].every((c) => isTransientFsError(codeError(c)))).toBe(true);
    expect(isTransientFsError(codeError('ENOENT'))).toBe(false);
    expect(isTransientFsError(null)).toBe(false);
  });
});
