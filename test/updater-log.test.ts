import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUpdaterLogger } from '../src/main/updaterLog';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ajza-updater-log-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('updater log', () => {
  it('appends timestamped lines and keeps earlier ones', () => {
    const file = join(dir, 'updater.log');
    const log = createUpdaterLogger(file);
    log.info('Checking for update');
    log.warn('slow');
    log.error(new Error('offline'));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z info Checking for update$/);
    expect(lines[1]).toMatch(/ warn slow$/);
    expect(lines[2]).toMatch(/ error offline$/);
  });

  it('starts over once the file grows too large', () => {
    const file = join(dir, 'updater.log');
    writeFileSync(file, 'x'.repeat(250 * 1024));
    createUpdaterLogger(file).info('fresh');
    expect(statSync(file).size).toBeLessThan(200);
    expect(readFileSync(file, 'utf8')).toContain('fresh');
  });

  it('moves a full file aside instead of emptying it when asked to rotate (crash.log)', () => {
    const file = join(dir, 'crash.log');
    const old = join(dir, 'crash.old.log');
    writeFileSync(file, 'before the crash\n' + 'x'.repeat(250 * 1024));
    createUpdaterLogger(file, { rotateTo: old }).error('after');
    expect(readFileSync(old, 'utf8')).toContain('before the crash');
    expect(readFileSync(file, 'utf8')).toContain('after');
    expect(statSync(file).size).toBeLessThan(200);
  });

  it('never throws, even when the file cannot be written', () => {
    expect(() => createUpdaterLogger(join(dir, 'missing', 'nested', 'updater.log')).info('ignored')).not.toThrow();
  });
});
