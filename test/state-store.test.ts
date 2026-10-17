import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAK_REFRESH_MS, createSaver, flushUntilSaved, loadState, retryDelayMs, StateUnreadableError, writeStateNow } from '../src/main/store';
import { addProject, defaultState } from '../src/shared/state';
import type { AppState } from '../src/shared/types';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-store-')); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

const withProject = (name: string): AppState => addProject(defaultState(), { name, path: `C:/${name}` });

describe('loadState', () => {
  it('keeps an unparsable state.json as a timestamped backup and falls back to .bak', () => {
    writeStateNow(dir, withProject('fromBak'));
    writeFileSync(join(dir, 'state.json.bak'), readFileSync(join(dir, 'state.json')));
    writeFileSync(join(dir, 'state.json'), '{ broken');
    const log = vi.fn();
    const state = loadState(dir, 'win32', { log });
    expect(state.projects.map((p) => p.name)).toEqual(['fromBak']);
    const kept = readdirSync(dir).filter((f) => f.startsWith('state.json.bak-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe('{ broken');
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('kept as'));
  });

  it('starts empty when neither file is usable, still keeping the damaged one', () => {
    writeFileSync(join(dir, 'state.json'), '[1,2');
    expect(loadState(dir).projects).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith('state.json.bak-'))).toBe(true);
  });

  it('refreshes .bak from a good state.json and keeps working when that copy fails', () => {
    writeStateNow(dir, withProject('main'));
    expect(loadState(dir).projects[0].name).toBe('main');
    expect(JSON.parse(readFileSync(join(dir, 'state.json.bak'), 'utf8')).projects[0].name).toBe('main');
    // A .bak that cannot be replaced (here: a directory in its place) must not stop the start.
    rmSync(join(dir, 'state.json.bak'));
    const blocker = join(dir, 'state.json.bak');
    mkdirSync(join(blocker, 'x'), { recursive: true });
    const log = vi.fn();
    expect(loadState(dir, 'win32', { log }).projects[0].name).toBe('main');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not refreshed'));
  });
});

describe('createSaver', () => {
  it('writes compact JSON', () => {
    writeStateNow(dir, defaultState());
    const text = readFileSync(join(dir, 'state.json'), 'utf8');
    expect(text).not.toContain('\n');
    expect(JSON.parse(text).version).toBe(1);
  });

  it('keeps the pending state when a save fails, retries with a backoff and never throws', () => {
    vi.useFakeTimers();
    let fail = 2;
    const written: AppState[] = [];
    const log = vi.fn();
    const saver = createSaver(dir, { debounceMs: 500, log, write: (_d, s) => { if (fail-- > 0) throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' }); written.push(s); } });
    const state = withProject('a');
    saver.save(state);
    vi.advanceTimersByTime(500);
    expect(written).toEqual([]);
    expect(saver.hasPending()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(retryDelayMs(1));
    expect(written).toEqual([]);
    vi.advanceTimersByTime(retryDelayMs(2));
    expect(written).toEqual([state]);
    expect(saver.hasPending()).toBe(false);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('after 2 failed'));
  });

  it('a newer state saved while a failed one waits wins, and flush at quit reports instead of throwing', () => {
    vi.useFakeTimers();
    let fail = true;
    const written: string[] = [];
    const saver = createSaver(dir, { write: (_d, s) => { if (fail) throw new Error('EPERM'); written.push(s.projects[0]?.name ?? ''); } });
    saver.save(withProject('old'));
    vi.advanceTimersByTime(500);
    saver.save(withProject('new'));
    expect(saver.flush()).toBe(false);
    fail = false;
    expect(saver.flush()).toBe(true);
    expect(written).toEqual(['new']);
  });

  it('refreshes .bak with a save at most once an hour', () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const baks: string[] = [];
    const saver = createSaver(dir, { now: () => now, write: () => {}, writeBak: (_d, s) => { baks.push(s.projects[0].name); } });
    saver.save(withProject('first'));
    saver.flush();
    expect(baks).toEqual([]);
    now += BAK_REFRESH_MS;
    saver.save(withProject('second'));
    saver.flush();
    now += 1000;
    saver.save(withProject('third'));
    saver.flush();
    expect(baks).toEqual(['second']);
  });
});

describe('a locked state.json', () => {
  const locked = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };

  it('is read again for a few seconds, then the start fails without touching it', () => {
    writeStateNow(dir, withProject('mine'));
    writeFileSync(join(dir, 'state.json.bak'), 'older');
    const before = readFileSync(join(dir, 'state.json'), 'utf8');
    const waits: number[] = [];
    expect(() => loadState(dir, 'win32', { readFile: locked, sleep: (ms) => waits.push(ms), lockedWaitMs: 4000 })).toThrow(StateUnreadableError);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4000);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'state.json.bak'), 'utf8')).toBe('older');
    // A copy is kept when the file can be copied at all.
    const kept = readdirSync(dir).filter((f) => f.startsWith('state.json.bak-'));
    expect(kept.map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual([before]);
  });

  it('loads normally when the lock goes away during the wait', () => {
    writeStateNow(dir, withProject('mine'));
    let tries = 0;
    const flaky = (path: string) => { if (tries++ < 3) locked(); return readFileSync(path, 'utf8'); };
    expect(loadState(dir, 'win32', { readFile: flaky, sleep: () => {} }).projects[0].name).toBe('mine');
  });

  it('removes temp files of writes that never finished, but not the files of this process', () => {
    writeStateNow(dir, withProject('mine'));
    for (const name of ['state.json.tmp', 'state.json.99999.abc1.tmp', 'state.json.bak.99999.x.tmp', `state.json.${process.pid}.zz.tmp`, 'other.json.99999.a.tmp']) writeFileSync(join(dir, name), 'x');
    loadState(dir);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp')).sort()).toEqual(['other.json.99999.a.tmp', `state.json.${process.pid}.zz.tmp`]);
  });
});

describe('flushUntilSaved', () => {
  it('tries a failed last save again until it works or the time is up', async () => {
    let pending = true;
    let attempts = 0;
    const saver = { flush: () => { attempts++; if (attempts >= 3) pending = false; return !pending; }, hasPending: () => pending };
    let clock = 0;
    expect(await flushUntilSaved(saver, 3000, 250, async (ms) => { clock += ms; }, () => clock)).toBe(true);
    expect(attempts).toBe(3);
    const stuck = { flush: () => false, hasPending: () => true };
    clock = 0;
    expect(await flushUntilSaved(stuck, 3000, 250, async (ms) => { clock += ms; }, () => clock)).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(3000);
  });
});
